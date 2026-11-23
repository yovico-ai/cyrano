package proxy

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// Cookies end to end through the handler: what the browser is told to
// store, and what the upstream receives (the rules themselves are checked
// against the spec, and the spec against Chromium).

func cookieUpstream(t *testing.T, setCookies ...string) (*httptest.Server, *capturedRequest) {
	t.Helper()
	captured := &capturedRequest{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured.headers = r.Header.Clone()
		for _, c := range setCookies {
			w.Header().Add("Set-Cookie", c)
		}
		w.WriteHeader(200)
	}))
	t.Cleanup(srv.Close)
	return srv, captured
}

func TestCookies_SetCookieRouting(t *testing.T) {
	upstream, _ := cookieUpstream(t,
		"visible=1; Path=/app; Max-Age=60",
		"secret=2; HttpOnly",
		"foreign=3; Domain=elsewhere.example", // a browser ignores it
		"__Host-h=4; Path=/",                  // needs Secure: ignored
	)
	up, _ := url.Parse(upstream.URL)
	jar := NewSessionJar()
	h := New(Options{ProxyCfg: devProxyCfg(), CookieJar: jar, SessionCookieName: "crnsct"})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", cyranoPath(upstream.URL+"/app/page"), nil)
	req.Host = "localhost:9081"
	h.ServeHTTP(rec, req)

	var session string
	var toBrowser []string
	for _, v := range rec.Header().Values("Set-Cookie") {
		if strings.HasPrefix(v, "crnsct=") {
			session = strings.TrimPrefix(strings.Split(v, ";")[0], "crnsct=")
			continue
		}
		if strings.HasPrefix(v, "crnsctb=") {
			continue // the browser-session marker
		}
		toBrowser = append(toBrowser, v)
	}
	host := up.Hostname()
	// Every cookie stays in the server's jar; a request with no page of its
	// own behind it (typed) is told nothing back (CookieJar.inboxFor).
	_ = host
	var want []string
	if strings.Join(toBrowser, " | ") != strings.Join(want, " | ") {
		t.Errorf("Set-Cookie to the browser:\n got  %q\n want %q", toBrowser, want)
	}
	if session == "" {
		t.Fatal("no session cookie issued")
	}
	if got := jar.Cookies(session); len(got) != 2 || got[0].Name != "visible" || got[0].HTTPOnly || got[1].Name != "secret" || !got[1].HTTPOnly || got[1].Path != "/app" {
		t.Errorf("server jar = %+v, want both, the second HttpOnly", got)
	}
}

func TestCookies_UpstreamGetsWhatABrowserWouldSend(t *testing.T) {
	upstream, captured := cookieUpstream(t)
	up, _ := url.Parse(upstream.URL)
	host := up.Hostname()
	jar := NewSessionJar()
	h := New(Options{ProxyCfg: devProxyCfg(), CookieJar: jar, SessionCookieName: "crnsct"})
	jar.NoteBrowserSession("sess", "bs1") // the browser session the requests come in
	jar.Store("sess", urlrewrite.StoredCookie{HostOnly: true, Domain: host, Path: "/", Name: "secret", Value: "2", HTTPOnly: true, SameSite: 'u'}, time.Time{})

	browserJar := strings.Join([]string{
		"crnsct=sess", "crnsctb=bs1",
		"__crn!h!" + host + "!%2F!a=iu:1",
		"__crn!h!" + host + "!%2Fapp!deep=iu:2",        // longer path: first
		"__crn!h!" + host + "!%2Fother!elsewhere=iu:3", // path does not match
		"__crn!h!other.example!%2F!foreign=iu:4",       // another site's
		"__crn!h!" + host + "!%2F!strict=it:5",         // SameSite=Strict
		"__crn!h!" + host + "!%2F!none=in:6",           // SameSite=None
		"unrelated=7",
	}, "; ")
	send := func(hdr map[string]string) string {
		req := httptest.NewRequest("GET", cyranoPath(upstream.URL+"/app/page"), nil)
		req.Host = "localhost:9081"
		req.Header.Set("Cookie", browserJar)
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		h.ServeHTTP(httptest.NewRecorder(), req)
		return captured.headers.Get("Cookie")
	}

	// (The jar's cookies before the old wire form's, among equal paths.)
	if got, want := send(nil), "deep=2; secret=2; a=1; strict=5; none=6"; got != want {
		t.Errorf("same-site request:\n got  %q\n want %q", got, want)
	}
	crossSite := map[string]string{
		"Referer": urlrewrite.Rewrite("https://page.example/x", nil, devProxyCfg()), "Sec-Fetch-Dest": "image", "Sec-Fetch-Mode": "no-cors",
	}
	if got, want := send(crossSite), "none=6"; got != want {
		t.Errorf("cross-site subresource request:\n got  %q\n want %q", got, want)
	}
	crossNav := map[string]string{
		"Referer": urlrewrite.Rewrite("https://page.example/x", nil, devProxyCfg()), "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
	}
	if got, want := send(crossNav), "deep=2; secret=2; a=1; none=6"; got != want {
		t.Errorf("cross-site top-level navigation (Lax allowed, Strict not):\n got  %q\n want %q", got, want)
	}
}

func TestCookies_NoJar_HttpOnlyStaysOutOfScriptsReach(t *testing.T) {
	upstream, _ := cookieUpstream(t, "secret=2; HttpOnly")
	h := New(Options{ProxyCfg: devProxyCfg()})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", cyranoPath(upstream.URL+"/"), nil)
	req.Host = "localhost:9081"
	h.ServeHTTP(rec, req)
	got := rec.Header().Values("Set-Cookie")
	if len(got) != 1 || !strings.HasSuffix(got[0], "; HttpOnly") || !strings.Contains(got[0], "!secret=iu:2") {
		t.Errorf("Set-Cookie = %q, want one real HttpOnly cookie under its wire name", got)
	}
}

func TestCookieExpiry(t *testing.T) {
	now := time.Now()
	for _, c := range []struct {
		set  string
		gone bool
		in   time.Duration // 0: a session cookie
	}{
		{"a=1", false, 0},
		{"a=1; Max-Age=60", false, time.Minute},
		{"a=1; Max-Age=0", true, 0},
		{"a=1; Max-Age=-5", true, 0},
		{"a=1; Max-Age=99999999999999999999", false, 400 * 24 * time.Hour},
		{"a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT", true, 0},
		{"a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60", false, time.Minute}, // Max-Age wins
		{"a=1; Expires=nonsense", false, 0},
	} {
		sc, _ := urlrewrite.ParseSetCookie(c.set)
		exp, gone := cookieExpiry(sc, now)
		switch {
		case gone != c.gone:
			t.Errorf("%q: gone = %v", c.set, gone)
		case c.in == 0 && !exp.IsZero() && !gone:
			t.Errorf("%q: expires %v, want a session cookie", c.set, exp)
		case c.in != 0 && exp.Sub(now) != c.in:
			t.Errorf("%q: expires in %v, want %v", c.set, exp.Sub(now), c.in)
		}
	}
}

// A request the page made without credentials — fetch's "omit", or its
// default to another origin — names that to the proxy in Crn-C (the
// runtime's patches/fetch.ts, xhr.ts): the upstream gets no cookies, from
// the browser's jar or the session's, and its Set-Cookie is not stored.
func TestCookies_CredentialsOmitSendsNoCookies(t *testing.T) {
	upstream, captured := cookieUpstream(t, "fresh=1; Path=/", "secret2=2; HttpOnly")
	up, _ := url.Parse(upstream.URL)
	host := up.Hostname()
	jar := NewSessionJar()
	h := New(Options{ProxyCfg: devProxyCfg(), CookieJar: jar, SessionCookieName: "crnsct"})
	jar.NoteBrowserSession("sess", "bs1")
	jar.Store("sess", urlrewrite.StoredCookie{HostOnly: true, Domain: host, Path: "/", Name: "secret", Value: "2", HTTPOnly: true, SameSite: 'u'}, time.Time{})
	browserJar := "crnsct=sess; crnsctb=bs1; __crn!h!" + host + "!%2F!a=iu:1"

	send := func(credentials string) (*httptest.ResponseRecorder, http.Header) {
		req := httptest.NewRequest("GET", cyranoPath(upstream.URL+"/api"), nil)
		req.Host = "localhost:9081"
		req.Header.Set("Cookie", browserJar)
		if credentials != "" {
			req.Header.Set(CredentialsHeader, credentials)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec, captured.headers
	}

	for _, omit := range []string{"omit", "OMIT"} {
		rec, got := send(omit)
		if c := got.Values("Cookie"); len(c) != 0 {
			t.Errorf("Crn-C %q: upstream Cookie = %q, want none", omit, c)
		}
		if v := got.Get(CredentialsHeader); v != "" {
			t.Errorf("Crn-C %q reached the upstream: %q", omit, v)
		}
		if sc := rec.Header().Values("Set-Cookie"); len(sc) != 0 {
			t.Errorf("Crn-C %q: Set-Cookie to the browser = %q, want none (not stored)", omit, sc)
		}
	}
	if stored := jar.Cookies("sess"); len(stored) != 1 || stored[0].Name != "secret" {
		t.Errorf("session jar after uncredentialed requests = %+v, want only the original cookie", stored)
	}

	// Control: the same request with credentials gets the cookies, and its
	// response's HttpOnly cookie is stored (sent on the next request).
	if _, got := send("include"); got.Get("Cookie") != "secret=2; a=1" {
		t.Errorf("Crn-C include: upstream Cookie = %q, want %q", got.Get("Cookie"), "secret=2; a=1")
	}
	if _, got := send(""); got.Get("Cookie") != "secret=2; fresh=1; secret2=2; a=1" {
		t.Errorf("no Crn-C: upstream Cookie = %q, want %q", got.Get("Cookie"), "secret=2; fresh=1; secret2=2; a=1")
	}
}
