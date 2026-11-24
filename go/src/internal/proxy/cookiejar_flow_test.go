package proxy

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/cookiejar"
	"github.com/yovico/cyrano/internal/urlrewrite"
)

// The server-side jar through the handler (spec/CookieJar.agda): a
// script's write rides the next request as an outbox entry and is applied
// once; a response's change comes back as an inbox entry; a browser restart
// ends the session cookies; the jar outlives the server; one site past its
// limit leaves the others alone.

func jarHandler(t *testing.T, jar *SessionJar, setCookies ...string) (*Handler, string, *capturedRequest) {
	t.Helper()
	// The Set-Cookies only on /set.
	captured := &capturedRequest{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured.headers = r.Header.Clone()
		if r.URL.Path == "/set" {
			for _, c := range setCookies {
				w.Header().Add("Set-Cookie", c)
			}
		}
	}))
	t.Cleanup(srv.Close)
	return New(Options{ProxyCfg: devProxyCfg(), CookieJar: jar, SessionCookieName: "crnsct"}), srv.URL, captured
}

func serve(h *Handler, target, cookie string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("GET", cyranoPath(target), nil)
	req.Host = "localhost:9081"
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// outboxEntry is a writer's slot holding one write numbered k.
func outboxEntry(t *testing.T, page, setCookie string, k uint64) string {
	t.Helper()
	sc, _ := urlrewrite.ParseSetCookie(setCookie)
	c, ok := urlrewrite.StoreCookie(true, page, sc)
	if !ok {
		t.Fatalf("%q not stored at %s", setCookie, page)
	}
	ch := cookiejar.Change{Cookie: c, Expiry: cookiejar.Expiry{Session: true}}
	return cookiejar.OutboxPrefix + "tab1!0=" + cookiejar.PackSlot([][2]string{{cookiejar.ChanName(false, ch), cookiejar.ChanValue(ch, k, nil)}})
}

func TestJarFlow_OutboxAppliedOnceAndAcked(t *testing.T) {
	jar := NewSessionJar()
	jar.NoteBrowserSession("s1", "b1")
	h, up, captured := jarHandler(t, jar)
	page := up + "/p"
	base := "crnsct=s1; crnsctb=b1; "

	rec := serve(h, page, base+outboxEntry(t, page, "w=1", 7))
	if got := captured.headers.Get("Cookie"); got != "w=1" {
		t.Errorf("upstream Cookie = %q, want the write it carried", got)
	}
	var ack string
	for _, v := range rec.Header().Values("Set-Cookie") {
		if strings.HasPrefix(v, cookiejar.AckPrefix) {
			ack = v
		}
		if strings.HasPrefix(v, cookiejar.InboxPrefix) {
			t.Errorf("an applied write echoed as an inbox entry: %q", v)
		}
	}
	if !strings.HasPrefix(ack, cookiejar.AckPrefix+"tab1=7!1;") || !strings.Contains(ack, "Priority=Low") {
		t.Errorf("ack = %q, want the writer's highest number and the jar's generation, low priority", ack)
	}
	// The same entry again (its response was lost), and an older one: ignored.
	serve(h, page, base+outboxEntry(t, page, "w=1", 7))
	serve(h, page, base+outboxEntry(t, page, "w=old", 6))
	if got := captured.headers.Get("Cookie"); got != "w=1" {
		t.Errorf("after a repeated and an older outbox: upstream Cookie = %q, want w=1", got)
	}
}

// A response's cookie is told back (inbox) to a page of its own site; with
// no page known, or on a document's own response, when it is the
// response's own site.
func TestJarFlow_InboxOnlyForThePagesSite(t *testing.T) {
	jar := NewSessionJar()
	jar.NoteBrowserSession("s1", "b1")
	h, up, _ := jarHandler(t, jar, "x=1")
	u, _ := url.Parse(up)
	inbox := func(referer, dest string) int {
		req := httptest.NewRequest("GET", cyranoPath(up+"/set"), nil)
		req.Host = "localhost:9081"
		req.Header.Set("Cookie", "crnsct=s1; crnsctb=b1")
		if referer != "" {
			req.Header.Set("Referer", urlrewrite.Rewrite(referer, nil, devProxyCfg()))
		}
		if dest != "" {
			req.Header.Set("Sec-Fetch-Dest", dest)
		}
		if dest == "document" {
			req.Header.Set("Sec-Fetch-Mode", "navigate") // as a browser sends it
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		n := 0
		for _, v := range rec.Header().Values("Set-Cookie") {
			if strings.HasPrefix(v, cookiejar.InboxPrefix) {
				n++
			}
		}
		return n
	}
	if n := inbox("http://"+u.Host+"/page", "empty"); n != 1 {
		t.Errorf("a fetch of the page's own site: %d inbox entries, want 1", n)
	}
	if n := inbox("https://other.example/page", "image"); n != 0 {
		t.Errorf("a third party's subresource: %d inbox entries, want 0", n)
	}
	// A document's own response (a download, a frame sent to JSON: no
	// snapshot comes with it), and one with no page known (a blob worker's
	// fetch): its own site's cookie is told.
	if n := inbox("http://"+u.Host+"/page", "document"); n != 1 {
		t.Errorf("a document's own response: %d inbox entries, want 1", n)
	}
	if n := inbox("", "empty"); n != 1 {
		t.Errorf("no page known: %d inbox entries, want 1 (the response's own site)", n)
	}
	if n := inbox("https://other.example/page", "document"); n != 1 {
		t.Errorf("a document's own response from another site's link: %d inbox entries, want 1", n)
	}
}

func TestJarFlow_BrowserRestartEndsSessionCookies(t *testing.T) {
	jar := NewSessionJar()
	h, up, captured := jarHandler(t, jar, "sess=1", "kept=2; Max-Age=3600")
	rec := serve(h, up+"/set", "")
	var sid, bs string
	for _, v := range rec.Header().Values("Set-Cookie") {
		kv := strings.Split(v, ";")[0]
		if n, val, _ := strings.Cut(kv, "="); n == "crnsct" {
			sid = val
		} else if n == "crnsctb" {
			bs = val
		}
	}
	if sid == "" || bs == "" {
		t.Fatalf("session %q, marker %q: want both", sid, bs)
	}
	serve(h, up+"/", "crnsct="+sid+"; crnsctb="+bs)
	if got := captured.headers.Get("Cookie"); got != "sess=1; kept=2" {
		t.Errorf("same browser session: upstream Cookie = %q", got)
	}
	// A restart (no marker), past the 30 s window of the last issue.
	// A restart (no marker) — at once: the browser had sent the marker, so
	// this is a new browser session however soon (round H restarted in 5 s).
	rec = serve(h, up+"/", "crnsct="+sid)
	if got := captured.headers.Get("Cookie"); got != "kept=2" {
		t.Errorf("after a browser restart: upstream Cookie = %q, want the persistent cookie only", got)
	}
	issued := false
	for _, v := range rec.Header().Values("Set-Cookie") {
		issued = issued || strings.HasPrefix(v, "crnsctb=")
	}
	if !issued {
		t.Error("no new browser-session marker issued")
	}
	// Requests sent before the browser stored the new marker (none has come
	// with it yet): the same one again, nothing ended again.
	serve(h, up+"/set", "crnsct="+sid)
	rec = serve(h, up+"/", "crnsct="+sid)
	// (sess was made again after the restart: kept, older, comes first.)
	if got := captured.headers.Get("Cookie"); got != "kept=2; sess=1" {
		t.Errorf("a second marker-less request in the window ended cookies: %q", got)
	}
}

func TestJarFlow_LegacyWireCookieLeavesOnceHeld(t *testing.T) {
	jar := NewSessionJar()
	jar.NoteBrowserSession("s1", "b1")
	h, up, captured := jarHandler(t, jar, "a=new")
	u, _ := url.Parse(up)
	legacy := "__crn!h!" + u.Hostname() + "!%2F!a"
	rec := serve(h, up+"/set", "crnsct=s1; crnsctb=b1; "+legacy+"=iu:old")
	if got := captured.headers.Get("Cookie"); got != "a=old" {
		t.Errorf("first request: upstream Cookie = %q, want the old wire form's", got)
	}
	cleared := false
	for _, v := range rec.Header().Values("Set-Cookie") {
		cleared = cleared || v == legacy+"=; Path=/; Max-Age=0"
	}
	if !cleared {
		t.Errorf("old wire cookie not cleared: %q", rec.Header().Values("Set-Cookie"))
	}
	serve(h, up+"/", "crnsct=s1; crnsctb=b1")
	if got := captured.headers.Get("Cookie"); got != "a=new" {
		t.Errorf("next request: upstream Cookie = %q, want the jar's", got)
	}
}

func TestJarFlow_OutlivesTheServer(t *testing.T) {
	dir := t.TempDir()
	sid := GenerateSessionID()
	jar := NewSessionJar(dir)
	jar.NoteBrowserSession(sid, "b1")
	h, up, captured := jarHandler(t, jar, "p=1; Max-Age=3600")
	serve(h, up+"/set", "crnsct="+sid+"; crnsctb=b1")
	jar.flush()
	again := NewSessionJar(dir)
	h2 := New(Options{ProxyCfg: devProxyCfg(), CookieJar: again, SessionCookieName: "crnsct"})
	serve(h2, up+"/", "crnsct="+sid+"; crnsctb=b1")
	if got := captured.headers.Get("Cookie"); got != "p=1" {
		t.Errorf("after a restart of the server: upstream Cookie = %q, want p=1", got)
	}
}

func TestJarFlow_ASiteLimitIsItsOwn(t *testing.T) {
	jar := NewSessionJar()
	jar.NoteBrowserSession("s1", "b1")
	for i := 0; i < 200; i++ {
		c := urlrewrite.StoredCookie{HostOnly: true, Domain: "busy.example", Path: "/", Name: fmt.Sprintf("c%d", i), Value: "1", SameSite: 'u', Priority: 'M'}
		jar.With("s1", func(j *cookiejar.Jar) {
			j.Put(false, unixNow(), "busy.example", cookiejar.Change{Cookie: c, Expiry: cookiejar.Expiry{Session: true}})
		})
		if i == 10 {
			o := urlrewrite.StoredCookie{HostOnly: true, Domain: "quiet.example", Path: "/", Name: "consent", Value: "yes", SameSite: 'u', Priority: 'M'}
			jar.With("s1", func(j *cookiejar.Jar) {
				j.Put(false, unixNow(), "quiet.example", cookiejar.Change{Cookie: o, Expiry: cookiejar.Expiry{Session: true}})
			})
		}
	}
	busy, quiet := 0, 0
	for _, c := range jar.Cookies("s1") {
		if c.Domain == "busy.example" {
			busy++
		} else {
			quiet++
		}
	}
	if busy > cookiejar.DomainMax || quiet != 1 {
		t.Errorf("busy.example keeps %d (≤ %d), quiet.example %d (want its one)", busy, cookiejar.DomainMax, quiet)
	}
	_ = http.StatusOK
}

// Chromium's Lax-allowing-unsafe: a cookie stating no SameSite goes on a
// cross-site top-level POST while at most two minutes old (OIDC form_post,
// SAML); one stating Lax does not, nor one older.
func TestJarFlow_LaxAllowingUnsafe(t *testing.T) {
	jar := NewSessionJar()
	jar.NoteBrowserSession("s1", "b1")
	h, up, captured := jarHandler(t, jar, "dflt=1; Path=/", "lax=1; Path=/; SameSite=Lax")
	serve(h, up+"/set", "crnsct=s1; crnsctb=b1")
	post := func() string {
		req := httptest.NewRequest("POST", cyranoPath(up+"/callback"), strings.NewReader("code=x"))
		req.Host = "localhost:9081"
		req.Header.Set("Cookie", "crnsct=s1; crnsctb=b1")
		req.Header.Set("Referer", urlrewrite.Rewrite("https://idp.example/login", nil, devProxyCfg()))
		req.Header.Set("Sec-Fetch-Mode", "navigate")
		req.Header.Set("Sec-Fetch-Dest", "document")
		h.ServeHTTP(httptest.NewRecorder(), req)
		return captured.headers.Get("Cookie")
	}
	if got := post(); got != "dflt=1" {
		t.Errorf("a cross-site top-level POST at once: upstream Cookie = %q, want the fresh default one only", got)
	}
	// Two minutes and more later.
	jar.mu.Lock()
	for i := range jar.get("s1").Jar.Entries {
		jar.get("s1").Jar.Entries[i].Created -= 121000
	}
	jar.mu.Unlock()
	if got := post(); got != "" {
		t.Errorf("the same POST past two minutes: upstream Cookie = %q, want none", got)
	}
}

// A response the proxy fails (the CORS check, ORB) still stores its
// cookies, as the browser does before either check; the inbox entry rides
// the session's next response.
func TestJarFlow_FailedResponseCookiesArriveNext(t *testing.T) {
	jar := NewSessionJar()
	jar.NoteBrowserSession("s1", "b1")
	h, up, _ := jarHandler(t, jar, "late=1; Path=/")
	u, _ := url.Parse(up)
	page := "http://" + u.Host + "/page"
	req := httptest.NewRequest("GET", cyranoPath(up+"/set"), nil)
	req.Host = "localhost:9081"
	req.Header.Set("Cookie", "crnsct=s1; crnsctb=b1")
	// A page of the same site on another port: cross-origin, the CORS check applies.
	other := "http://" + u.Hostname() + ":1/x"
	req.Header.Set("Referer", urlrewrite.Rewrite(other, nil, devProxyCfg()))
	req.Header.Set("Sec-Fetch-Mode", "cors")
	req.Header.Set("Sec-Fetch-Dest", "empty")
	req.Header.Set(InitiatorHeader, other)
	req.Header.Set(CredentialsHeader, "include")
	rec := httptest.NewRecorder()
	func() { // no ACAO: the CORS check fails — the connection is broken (ErrAbortHandler)
		defer func() { _ = recover() }()
		h.ServeHTTP(rec, req)
	}()
	found := false
	for _, c := range jar.Cookies("s1") {
		found = found || c.Name == "late"
	}
	if !found {
		t.Fatal("a CORS-failed response's cookie was not stored")
	}
	next := httptest.NewRequest("GET", cyranoPath(up+"/"), nil)
	next.Host = "localhost:9081"
	next.Header.Set("Cookie", "crnsct=s1; crnsctb=b1")
	next.Header.Set("Referer", urlrewrite.Rewrite(page, nil, devProxyCfg()))
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, next)
	told := false
	for _, v := range rec2.Header().Values("Set-Cookie") {
		told = told || strings.HasPrefix(v, cookiejar.InboxPrefix) && strings.Contains(v, "!late=")
	}
	if !told {
		t.Errorf("its inbox entry did not ride the next response: %q", rec2.Header().Values("Set-Cookie"))
	}
}
