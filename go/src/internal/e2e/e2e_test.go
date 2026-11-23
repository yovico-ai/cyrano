//go:build e2e

package e2e

import (
	"bytes"
	"encoding/base64"
	"encoding/xml"
	"html"
	"net/url"
	"regexp"
	"compress/gzip"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"testing"
	"time"

	crnjar "github.com/yovico/cyrano/internal/cookiejar"
	"github.com/yovico/cyrano/internal/urlrewrite"
)

// TestE2E_XForwardedFor — the proxy must strip X-Forwarded-For so it never
// reaches the upstream.
func TestE2E_XForwardedFor(t *testing.T) {
	fixture := startFixtureServer(t)
	proxy := startProxy(t)

	hdrs := getEchoHeaders(t, proxy, fixture.URL)

	if _, present := hdrs["x-forwarded-for"]; present {
		t.Errorf("x-forwarded-for leaked to upstream: %v", hdrs["x-forwarded-for"])
	}
}

// TestE2E_AcceptEncoding — when a request arrives with no Accept-Encoding,
// the proxy must set a browser-realistic value (gzip + deflate + br).
// Uses a client with DisableCompression so Go's transport doesn't auto-add
// "Accept-Encoding: gzip" before the proxy sees the request.
func TestE2E_AcceptEncoding(t *testing.T) {
	fixture := startFixtureServer(t)
	proxy := startProxy(t)

	hdrs := getEchoHeadersNoCompression(t, proxy, fixture.URL)

	ae := strings.Join(hdrs["accept-encoding"], ",")
	for _, want := range []string{"gzip", "deflate", "br"} {
		if !strings.Contains(ae, want) {
			t.Errorf("accept-encoding missing %q (full value: %q)", want, ae)
		}
	}
}

// TestE2E_BrotliDecode — the proxy must decompress Content-Encoding:br
// responses so the client receives plain HTML.
func TestE2E_BrotliDecode(t *testing.T) {
	fixture := startFixtureServer(t)
	proxy := startProxy(t)

	status, body := getVia(t, proxy, fixture.URL+"/brotli-page")

	if status != 200 {
		t.Fatalf("status %d; body: %.200s", status, body)
	}
	if !strings.Contains(body, "brotli body decompressed correctly") {
		t.Errorf("brotli body not decoded; snippet: %.200s", body)
	}
}

// TestE2E_SetCookiePrefixed — a Set-Cookie from the upstream is kept in the
// session's jar; the browser is told it as an inbox entry scoped to the
// origin's host (spec/CookieJar.agda), which the runtime absorbs.
func TestE2E_SetCookiePrefixed(t *testing.T) {
	upstream := startInlineServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "session", Value: "abc123", Path: "/"})
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ok"))
	})
	proxy := startProxy(t)

	// As the page's own fetch() would ask: its Referer, no document.
	req, _ := http.NewRequest("GET", gotoURL(proxy, upstream.URL+"/"), nil)
	req.Header.Set("Referer", gotoURL(proxy, upstream.URL+"/page"))
	req.Header.Set("Sec-Fetch-Dest", "empty")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	found := false
	for _, sc := range resp.Cookies() {
		if ch, _, ap, ok := crnjar.Unchan(true, sc.Name, sc.Value); ok && ap != nil && !ch.Gone && ch.Cookie.Name == "session" &&
			ch.Cookie.Value == "abc123" && ch.Cookie.HostOnly && ch.Cookie.Domain == "127.0.0.1" {
			found = true
		}
	}
	if !found {
		t.Errorf("no prefixed Set-Cookie found; got: %v", resp.Cookies())
	}
}

// TestE2E_CookieIsolation — cookies namespaced for fixture-a.test must be
// forwarded when proxying to A, but not when proxying to B, and vice versa.
func TestE2E_CookieIsolation(t *testing.T) {
	fixture := startFixtureServer(t)
	proxy := startProxy(t)

	// Both hostnames resolve to 127.0.0.1 via /etc/hosts (or skip if not set).
	aBase := fixtureURL(fixture, "fixture-a.test")
	bBase := fixtureURL(fixture, "fixture-b.test")

	if !resolvesTo127(t, "fixture-a.test") || !resolvesTo127(t, "fixture-b.test") {
		t.Skip("fixture-a.test / fixture-b.test not in /etc/hosts — add '127.0.0.1 fixture-a.test fixture-b.test'")
	}

	// Simulate browser jar: both sites' cookies in cyrano's wire form.
	wire := func(host, name, value string) string {
		c := urlrewrite.StoredCookie{Name: name, Value: value, Domain: host, Path: "/", HostOnly: true, SameSite: 'l'}
		return c.WireName() + "=" + c.WireValue()
	}
	jar := wire("fixture-a.test", "a_secret", "for_a") + "; " + wire("fixture-b.test", "b_secret", "for_b")

	// Proxy request to site A: must see a_secret, must NOT see b_secret.
	cookiesA := getEchoCookies(t, proxy, aBase, jar)
	if cookiesA["a_secret"] != "for_a" {
		t.Errorf("site A: want a_secret=for_a, got %v", cookiesA)
	}
	if _, leaked := cookiesA["b_secret"]; leaked {
		t.Errorf("site A: b_secret leaked: %v", cookiesA)
	}

	// Proxy request to site B: must see b_secret, must NOT see a_secret.
	cookiesB := getEchoCookies(t, proxy, bBase, jar)
	if cookiesB["b_secret"] != "for_b" {
		t.Errorf("site B: want b_secret=for_b, got %v", cookiesB)
	}
	if _, leaked := cookiesB["a_secret"]; leaked {
		t.Errorf("site B: a_secret leaked: %v", cookiesB)
	}
}

// resolvesTo127 returns true if hostname resolves to a loopback address.
func resolvesTo127(t *testing.T, hostname string) bool {
	t.Helper()
	addrs, err := net.LookupHost(hostname)
	if err != nil {
		return false
	}
	for _, a := range addrs {
		if strings.HasPrefix(a, "127.") || a == "::1" {
			return true
		}
	}
	return false
}

// A script's URL is marked (/cyrano/http!js/…): its response is rewritten
// as JavaScript whatever its Content-Type, which is left as the origin
// sent it; the same file fetched as data (unmarked, Sec-Fetch-Dest: empty)
// is the origin's bytes. Two URLs, so the browser's HTTP cache never hands
// the script the data copy (it ran unrewritten: the page read the proxy's
// URL as location.href).
func TestE2E_ScriptByMarkNotByType(t *testing.T) {
	const src = "window.__seen = location.href;"
	up := startInlineServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("Cache-Control", "max-age=3600")
		_, _ = io.WriteString(w, src)
	})
	proxy := startProxy(t)
	get := func(u, dest string) (string, string) {
		req, _ := http.NewRequest("GET", u, nil)
		req.Header.Set("Sec-Fetch-Dest", dest)
		resp, err := noCompressionClient().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return string(b), resp.Header.Get("Content-Type")
	}
	plain := gotoURL(proxy, up.URL+"/x.js")
	marked := strings.Replace(plain, "/cyrano/http/", "/cyrano/http!js/", 1)

	body, ct := get(marked, "script")
	if body == src || !strings.Contains(body, "$rewriter") {
		t.Errorf("marked script not rewritten as JavaScript: %q", body)
	}
	if ct != "text/plain" {
		t.Errorf("Content-Type changed to %q", ct)
	}
	if body, ct = get(plain, "empty"); body != src || ct != "text/plain" {
		t.Errorf("fetched as data: %q (%s), want the origin's bytes", body, ct)
	}
	// Unmarked, a script by its Sec-Fetch-Dest is rewritten too.
	if body, _ = get(plain, "script"); body == src {
		t.Errorf("script by Sec-Fetch-Dest not rewritten")
	}
}

// TestE2E_NoRuntimeWhereNoScriptRuns — a page under which no script of its
// own can run (spec/Csp.agda noScriptsRun) gets no bootstrap; natively it
// runs nothing, and the runtime would be the only script there. Its URLs
// are still rewritten.
func TestE2E_NoRuntimeWhereNoScriptRuns(t *testing.T) {
	page := `<!doctype html><title>x</title><a href="/next">n</a><script>1</script>`
	for csp, wantRuntime := range map[string]bool{
		"":                             true,
		"default-src 'none'":           false,
		"script-src 'none'; img-src *": false,
		"script-src 'self'":            true,
		"script-src-elem 'none'":       true, // inline handlers are governed by nothing: they run
		"default-src 'none'; script-src 'unsafe-inline'": true,
		"sandbox":               false, // Microsoft's company-target sync frame
		"sandbox allow-forms":   false,
		"sandbox allow-scripts": true,
		"sandbox ALLOW-SCRIPTS allow-same-origin": true,
	} {
		up := startInlineServer(t, func(w http.ResponseWriter, r *http.Request) {
			if csp != "" {
				w.Header().Set("Content-Security-Policy", csp)
			}
			w.Header().Set("Content-Type", "text/html")
			_, _ = io.WriteString(w, page)
		})
		proxy := startProxy(t)
		status, body := getVia(t, proxy, up.URL+"/")
		if status != 200 {
			t.Fatalf("%q: status %d", csp, status)
		}
		if got := strings.Contains(body, "/rewriter.js"); got != wantRuntime { // inline or external bootstrap
			t.Errorf("%q: runtime injected %v, want %v\n%.300s", csp, got, wantRuntime, body)
		}
		if !strings.Contains(body, "/cyrano/http/") {
			t.Errorf("%q: the page's URLs are not rewritten:\n%.300s", csp, body)
		}
	}
}

// TestE2E_OrbBlocksCrossOriginData — a <script> to another origin is asked
// in the page's own mode (spec/Orb.agda). No-cors (no crossorigin): a
// response Chromium's ORB blocks (JSON here) is a network error natively,
// so the proxy breaks the connection, Access-Control-Allow-Origin or not
// (Lenovo's /leid/assign; snowball-io's HTML with ACAO *). Cors
// (crossorigin, a module): the CORS check by the page's origin, a redirect
// too. Not for a same-origin script or one with no page of ours behind it.
func TestE2E_OrbBlocksCrossOriginData(t *testing.T) {
	up := startInlineServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("acao") == "1" {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		}
		if r.URL.Query().Get("moved") == "1" {
			// adform's trackpoint: a 301 whose body is HTML; the browser
			// follows it, ORB judges where it ends.
			w.Header().Set("Content-Type", "text/html")
			w.Header().Set("Location", "/leid/assign?js=1")
			w.WriteHeader(http.StatusMovedPermanently)
			_, _ = io.WriteString(w, "<html><head><title>301 Moved Permanently</title></head></html>")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("js") == "1" {
			_, _ = io.WriteString(w, "window.ran = 1;")
			return
		}
		_, _ = io.WriteString(w, `{"status":"200","data":null}`)
	})
	proxy := startProxy(t)
	port := up.URL[strings.LastIndex(up.URL, ":")+1:]
	dest, mode := "script", "no-cors"
	load := func(page, query string) error {
		u := strings.Replace(gotoURL(proxy, up.URL+"/leid/assign"+query), "/cyrano/http/", "/cyrano/http!js/", 1)
		req, _ := http.NewRequest("GET", u, nil)
		req.Header.Set("Sec-Fetch-Dest", dest)
		req.Header.Set("Sec-Fetch-Mode", mode)
		if page != "" {
			req.Header.Set("Referer", gotoURL(proxy, page))
		}
		resp, err := noCompressionClient().Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		_, err = io.ReadAll(resp.Body)
		if err == nil && resp.StatusCode != 200 && resp.StatusCode != http.StatusMovedPermanently {
			t.Errorf("%s%s: status %d", page, query, resp.StatusCode)
		}
		return err
	}
	cross := "http://localhost:" + port + "/p"
	type c struct{ page, query string }
	check := func(fail, pass []c) {
		for _, x := range fail {
			if err := load(x.page, x.query); err == nil {
				t.Errorf("%s %q%s: answered, want a broken connection", mode, x.page, x.query)
			}
		}
		for _, x := range pass {
			if err := load(x.page, x.query); err != nil {
				t.Errorf("%s %q%s: %v, want the response", mode, x.page, x.query, err)
			}
		}
	}
	// no-cors: ORB, whatever ACAO says; a script, a redirect, same-origin,
	// no page known: the response.
	check([]c{{cross, ""}, {cross, "?acao=1"}},
		[]c{{cross, "?js=1"}, {cross, "?moved=1"}, {up.URL + "/p", ""}, {"", ""}})
	// cors: the CORS check — no ACAO fails (a script, a redirect); ORB does not apply.
	mode = "cors"
	check([]c{{cross, "?js=1"}, {cross, "?moved=1"}, {cross, ""}},
		[]c{{cross, "?js=1&acao=1"}, {cross, "?acao=1"}, {up.URL + "/p", "?js=1"}, {"", "?js=1"}})
	// cors, asked by a script (a module's import: its Referer is the
	// importing module, marked !js): the page behind it is not known, so
	// nothing is judged.
	importer := strings.Replace(gotoURL(proxy, "http://localhost:"+port+"/m.js"), "/cyrano/http/", "/cyrano/http!js/", 1)
	{
		u := strings.Replace(gotoURL(proxy, up.URL+"/leid/assign?js=1"), "/cyrano/http/", "/cyrano/http!js/", 1)
		req, _ := http.NewRequest("GET", u, nil)
		req.Header.Set("Sec-Fetch-Dest", "script")
		req.Header.Set("Sec-Fetch-Mode", "cors")
		req.Header.Set("Referer", importer)
		if resp, err := noCompressionClient().Do(req); err != nil {
			t.Errorf("cors import by a module: %v, want the response", err)
		} else {
			_, err = io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil {
				t.Errorf("cors import by a module: %v, want the response", err)
			}
		}
	}
	// Only a script: a fetch() of the same data gets it (the runtime's CORS
	// headers decide there).
	dest = "empty"
	if err := load(cross, ""); err != nil {
		t.Errorf("fetch of cross-origin JSON: %v, want the response", err)
	}
}

// TestE2E_SVGPresentationURLAttr — Google Charts' clip-path naming the page
// itself (spec/Attrs.agda cssValue): rewritten as CSS to the proxied page,
// so the reference stays within the document, as directly; a fragment-only
// one stays as written; the page reads back the original.
func TestE2E_SVGPresentationURLAttr(t *testing.T) {
	var self string
	up := startInlineServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, `<!doctype html><svg><defs><clipPath id="c"><rect width="9" height="9"/></clipPath></defs>`+
			`<g clip-path="url(`+self+`/p#c)" fill="url(#g)" stroke="red"><rect width="99" height="99"/></g></svg>`)
	})
	self = up.URL
	proxy := startProxy(t)
	status, body := getVia(t, proxy, up.URL+"/p")
	if status != 200 {
		t.Fatalf("status %d", status)
	}
	// (The CSS rewriter writes the URL quoted: spec/Css.agda rewriteCss.)
	want := `clip-path="url(&#34;` + gotoURL(proxy, up.URL+"/p") + `#c&#34;)"`
	if !strings.Contains(body, want) {
		t.Errorf("clip-path not rewritten to the proxied page:\nwant %s\n%.600s", want, body)
	}
	if !strings.Contains(body, `fill="url(#g)"`) || !strings.Contains(body, `stroke="red"`) {
		t.Errorf("a fragment-only reference or a plain value changed:\n%.600s", body)
	}
	if !strings.Contains(body, `crn-o=`) || !strings.Contains(body, `clip-path`) {
		t.Errorf("no original kept for read-back:\n%.600s", body)
	}
}

// TestE2E_FramedPageKeepsItsEmbedder — a frame that navigates itself is
// still embedded by its parent (spec/Frames.agda embedderOf): the parent
// gives the frame a marked URL; the frame then goes to another site's
// login page and is sent back, unmarked, with the login page as Referer —
// its frame-ancestors is judged against the parent, not the login page
// (support.microsoft.com's silent sign-in frame was refused).
func TestE2E_FramedPageKeepsItsEmbedder(t *testing.T) {
	up := startInlineServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/back" {
			w.Header().Set("Content-Security-Policy", "frame-ancestors 'self'")
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, "<!doctype html><title>t</title>")
	})
	proxy := startProxy(t)
	port := up.URL[strings.LastIndex(up.URL, ":")+1:]
	site := up.URL                      // the parent's site (127.0.0.1)
	login := "http://localhost:" + port // another origin
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	nav := func(target, referer, dest string, marked bool) string {
		u := gotoURL(proxy, target)
		if marked {
			u = strings.Replace(u, "/cyrano/http/", "/cyrano/http!frame/", 1)
		}
		req, _ := http.NewRequest("GET", u, nil)
		req.Header.Set("Sec-Fetch-Mode", "navigate")
		req.Header.Set("Sec-Fetch-Dest", dest)
		if referer != "" {
			req.Header.Set("Referer", gotoURL(proxy, referer))
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("%s: %v", target, err)
		}
		defer resp.Body.Close()
		_, _ = io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			t.Fatalf("%s: status %d", target, resp.StatusCode)
		}
		return resp.Header.Get("Content-Security-Policy")
	}
	nav(site+"/parent", "", "document", false)               // the page (sets the session)
	nav(site+"/silent", site+"/parent", "iframe", true)      // its frame, given by the parent
	nav(login+"/authorize", site+"/silent", "iframe", false) // the frame goes to the login page itself
	// … and is sent back: unmarked, Referer the login page. Its parent is still the page.
	if csp := nav(site+"/back", login+"/authorize", "iframe", false); csp != "frame-ancestors 'self'" {
		t.Errorf("a frame back from another site: %q, want frame-ancestors 'self' (its parent is same-origin)", csp)
	}
	// A frame the login page itself embeds (marked) is judged against the login page.
	if csp := nav(site+"/back", login+"/authorize", "iframe", true); csp != "frame-ancestors 'none'" {
		t.Errorf("a frame of the other site's page: %q, want frame-ancestors 'none'", csp)
	}
}

// TestE2E_RedirectKeepsWhatTheRequestIsFor — a redirect is the same request
// going on (spec/Containment.agda redirectMark): the Location of a marked
// request carries its mark — a redirected frame is still its parent's
// frame, a redirected script still a script — and an unmarked one none.
func TestE2E_RedirectKeepsWhatTheRequestIsFor(t *testing.T) {
	up := startInlineServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/landed", http.StatusFound)
	})
	proxy := startProxy(t)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for mark, want := range map[string]string{"": "/cyrano/http/", "!frame": "/cyrano/http!frame/", "!js": "/cyrano/http!js/", "!origin!frame": "/cyrano/http!frame/"} {
		u := strings.Replace(gotoURL(proxy, up.URL+"/start"), "/cyrano/http/", "/cyrano/http"+mark+"/", 1)
		resp, err := client.Get(u)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		loc := resp.Header.Get("Location")
		if !strings.Contains(loc, want) || !strings.HasSuffix(loc, "/landed") {
			t.Errorf("mark %q: Location %q, want it under %s", mark, loc, want)
		}
	}
}

// TestE2E_InertFrameGetsNoRuntime — a frame sandboxed without
// allow-scripts runs no script (spec/Frames.agda frameDest, inertFrame):
// its document, marked inert by the document holding it, gets no
// bootstrap — nor does what that frame then navigates itself to. A frame
// that may run scripts gets it as ever.
func TestE2E_InertFrameGetsNoRuntime(t *testing.T) {
	up := startInlineServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, `<!doctype html><title>t</title><a href="/next">n</a>`)
	})
	proxy := startProxy(t)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	get := func(target, referer, dest, mark string) string {
		u := strings.Replace(gotoURL(proxy, target), "/cyrano/http/", "/cyrano/http"+mark+"/", 1)
		req, _ := http.NewRequest("GET", u, nil)
		req.Header.Set("Sec-Fetch-Mode", "navigate")
		req.Header.Set("Sec-Fetch-Dest", dest)
		if referer != "" {
			req.Header.Set("Referer", gotoURL(proxy, referer))
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("%s: %v", target, err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return string(b)
	}
	runtime := func(body string) bool { return strings.Contains(body, "/rewriter.js") }
	if !runtime(get(up.URL+"/page", "", "document", "")) {
		t.Fatal("the page itself has no runtime")
	}
	if body := get(up.URL+"/sandboxed", up.URL+"/page", "iframe", "!inert"); runtime(body) || !strings.Contains(body, "/cyrano/http/") {
		t.Errorf("an inert frame: runtime %v, want none and its URLs rewritten:\n%.300s", runtime(body), body)
	}
	if body := get(up.URL+"/next", up.URL+"/sandboxed", "iframe", ""); runtime(body) {
		t.Errorf("an inert frame navigating itself got the runtime:\n%.300s", body)
	}
	if !runtime(get(up.URL+"/frame", up.URL+"/page", "iframe", "!frame")) {
		t.Error("a frame that may run scripts has no runtime")
	}
	// The same URL loaded as a page afterwards is a page again.
	if !runtime(get(up.URL+"/next", "", "document", "")) {
		t.Error("a top-level document that was once an inert frame's has no runtime")
	}
}

// TestE2E_RewrittenBodyIsCompressed — a body the proxy rewrote goes to the
// browser in a coding it accepts (proxy/compress.go), and a script still
// reads the origin's Content-Encoding (Crn-H: none here); a browser that
// accepts no coding gets it plain.
func TestE2E_RewrittenBodyIsCompressed(t *testing.T) {
	page := `<!doctype html><title>t</title>` + strings.Repeat(`<a href="/next">a link to rewrite</a>`+"\n", 200)
	up := startInlineServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, page)
	})
	proxy := startProxy(t)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Transport: &http.Transport{DisableCompression: true}}
	get := func(accept string) (*http.Response, []byte) {
		req, _ := http.NewRequest("GET", gotoURL(proxy, up.URL+"/page"), nil)
		req.Header.Set("Sec-Fetch-Mode", "navigate")
		req.Header.Set("Sec-Fetch-Dest", "document")
		if accept != "" {
			req.Header.Set("Accept-Encoding", accept)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp, b
	}
	plainResp, plain := get("")
	if plainResp.Header.Get("Content-Encoding") != "" || !strings.Contains(string(plain), "/cyrano/http/") {
		t.Fatalf("no Accept-Encoding: Content-Encoding %q, rewritten %v", plainResp.Header.Get("Content-Encoding"), strings.Contains(string(plain), "/cyrano/http/"))
	}
	resp, enc := get("gzip, deflate")
	if resp.Header.Get("Content-Encoding") != "gzip" || len(enc) >= len(plain) {
		t.Fatalf("Accept-Encoding gzip: Content-Encoding %q, %d bytes (plain %d)", resp.Header.Get("Content-Encoding"), len(enc), len(plain))
	}
	zr, err := gzip.NewReader(bytes.NewReader(enc))
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(zr)
	if string(got) != string(plain) {
		t.Errorf("the encoded body decodes to %d bytes, the plain one is %d", len(got), len(plain))
	}
	if h := resp.Header.Get("Crn-H"); !strings.Contains(h, `"content-encoding":null`) {
		t.Errorf("Crn-H does not say the origin sent no Content-Encoding: %s", h)
	}
}

// TestE2E_PrefetchedPageIsADocument — <link rel=prefetch> asks with
// Sec-Fetch-Dest empty and Sec-Purpose: prefetch, and Chromium serves the
// navigation to that URL from it while it is fresh: answered as data, the
// origin's page became the proxied document, everything it loaded and its
// next link off the proxy (togaze.com). Judged as a document
// (spec/Disposition.agda judgedDest): a page is rewritten, data stays as sent.
func TestE2E_PrefetchedPageIsADocument(t *testing.T) {
	const page = `<!doctype html><html><head><script src="https://cdn.example/a.js"></script></head><body>next</body></html>`
	up := startInlineServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "max-age=300")
		if strings.HasSuffix(r.URL.Path, ".json") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"u":"https://cdn.example/x"}`)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, page)
	})
	proxy := startProxy(t)
	get := func(u string, h map[string]string) string {
		req, _ := http.NewRequest("GET", u, nil)
		for k, v := range h {
			req.Header.Set(k, v)
		}
		resp, err := noCompressionClient().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return string(b)
	}
	next := gotoURL(proxy, up.URL+"/next")
	prefetch := map[string]string{"Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "no-cors", "Sec-Purpose": "prefetch"}
	if body := get(next, prefetch); !strings.Contains(body, "$rewriter_init") || strings.Contains(body, `src="https://cdn.example/a.js"`) {
		t.Errorf("a prefetched page must be rewritten as the document it becomes:\n%s", body)
	}
	if body := get(next, map[string]string{"Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors"}); body != page {
		t.Errorf("a fetch() of the page is the page's data, as sent:\n%s", body)
	}
	if body := get(gotoURL(proxy, up.URL+"/d.json"), prefetch); body != `{"u":"https://cdn.example/x"}` {
		t.Errorf("prefetched data stays as sent: %s", body)
	}
}

// TestE2E_WebSocketCookies — a WebSocket's handshake carries the cookies a
// direct browser sends its server: that site's, under their own names.
// It forwarded the browser's Cookie header as it came — every proxied
// site's cookies and the proxy's session cookie went to the socket's
// server (foxnews.com refused the handshake as too large).
func TestE2E_WebSocketCookies(t *testing.T) {
	got := make(chan string, 1)
	up := startInlineServer(t, func(w http.ResponseWriter, r *http.Request) {
		got <- strings.Join(r.Header.Values("Cookie"), "; ")
		hj, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "no hijack", 500)
			return
		}
		c, _, err := hj.Hijack()
		if err != nil {
			return
		}
		defer c.Close()
		_, _ = io.WriteString(c, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x\r\n\r\n")
	})
	proxy := startProxy(t)
	host := strings.TrimPrefix(up.URL, "http://")
	wire := func(h, name, value string) string {
		c := urlrewrite.StoredCookie{Name: name, Value: value, Domain: h, Path: "/", HostOnly: true, SameSite: 'l'}
		return c.WireName() + "=" + c.WireValue()
	}
	jar := wire("127.0.0.1", "mine", "1") + "; " + wire("other.example", "theirs", "2") + "; crnsct=session-secret"

	conn, err := net.Dial("tcp", strings.TrimPrefix(proxy.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, _ = io.WriteString(conn, "GET /cyrano/ws/"+host+"/sock HTTP/1.1\r\nHost: "+strings.TrimPrefix(proxy.URL, "http://")+
		"\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: "+proxy.URL+
		"\r\nCookie: "+jar+"\r\n\r\n")
	var cookie string
	select {
	case cookie = <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("the handshake never reached the server")
	}
	if cookie != "mine=1" {
		t.Errorf("handshake Cookie = %q, want only this site's cookie, as named (mine=1)", cookie)
	}
}

// TestE2E_DataScriptRewritten — a <script src="data:…"> in markup (classic
// or module) runs text the rewriter never saw: it is read as the browser
// reads it, rewritten, and given a data: URL of the rewritten text
// (spec/DataUrl.agda); a relative specifier stays as written (it resolves
// against nothing, as natively); a data: URL that does not read, or that
// is no script's, is left; the page's URL is kept for read-back.
func TestE2E_DataScriptRewritten(t *testing.T) {
	enc := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	classic := `import("https://cdn.example/a.js")`
	module := `import "https://cdn.example/b.js"; import "./rel.js";`
	up := startInlineServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, `<!doctype html><head>`+
			`<script id="c" src="data:text/javascript;base64,`+enc(classic)+`"></script>`+
			`<script id="m" type="module" src="data:text/javascript,`+url.PathEscape(module)+`"></script>`+
			`<script id="j" type="application/json" src="data:,`+url.PathEscape(classic)+`"></script>`+
			`<script id="x" src="data:text/javascript;base64,%%%"></script>`+
			`<script>import("data:text/javascript,import%20%22https://cdn.example/lit.js%22")</script>`)
	})
	proxy := startProxy(t)
	status, body := getVia(t, proxy, up.URL+"/p")
	if status != 200 {
		t.Fatalf("status %d", status)
	}
	srcOf := func(id string) string {
		m := regexp.MustCompile(`id="` + id + `"[^>]*?src="([^"]*)"|src="([^"]*)"[^>]*?id="` + id + `"`).FindStringSubmatch(body)
		if m == nil {
			t.Fatalf("no script %s:\n%.900s", id, body)
		}
		return html.UnescapeString(m[1] + m[2])
	}
	text := func(src string) string {
		d, ok := urlrewrite.ReadDataURL(src)
		if !ok {
			t.Fatalf("not a data: URL that reads: %q", src)
		}
		return string(d.Body)
	}
	c := text(srcOf("c"))
	if !strings.Contains(c, "/cyrano/https") || strings.Contains(c, `import("https://cdn.example/a.js")`) {
		t.Errorf("classic data: script's import() not proxified: %q", c)
	}
	m := text(srcOf("m"))
	if !strings.Contains(m, "/cyrano/https") || !strings.Contains(m, `"./rel.js"`) {
		t.Errorf("module data: script: absolute proxified, relative as written, got %q", m)
	}
	if srcOf("j") != "data:,"+url.PathEscape(classic) || srcOf("x") != "data:text/javascript;base64,%%%" {
		t.Errorf("a data script that is no JavaScript, or does not read, changed:\n%.900s", body)
	}
	if !strings.Contains(body, `crn-o=`) {
		t.Errorf("no original kept for read-back:\n%.900s", body)
	}
	// A literal import() of a data: module: its text rewritten in place.
	// (The edit is marked: the original in a comment, then the new value.)
	lit := regexp.MustCompile(`import\([^)]*\*/"(data:text/javascript;base64,[^"]*)"`).FindStringSubmatch(body)
	if lit == nil {
		t.Fatalf("no literal data: import:\n%.1500s", body)
	}
	if l := text(lit[1]); !strings.Contains(l, "/cyrano/https") {
		t.Errorf("a literal import() of a data: module not rewritten: %q", l)
	}
}

// TestE2E_SpeculationRulesHeader — the rule sets a Speculation-Rules header
// names are fetched by the browser itself: they go through the proxy
// (spec/Speculation.agda; chadscafe.com's came from its origin); scripts
// read the origin's value (Crn-H).
func TestE2E_SpeculationRulesHeader(t *testing.T) {
	const sent = `"https://static.cdn-website.com/speculations/rules/prerender-1.0.3.json", "/cdn-cgi/speculation"`
	up := startInlineServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("Speculation-Rules", sent)
		_, _ = io.WriteString(w, `<!doctype html>x`)
	})
	proxy := startProxy(t)
	resp := getViaRaw(t, proxy, up.URL+"/p")
	defer resp.Body.Close()
	got := resp.Header.Get("Speculation-Rules")
	want := `"` + gotoURL(proxy, "https://static.cdn-website.com/speculations/rules/prerender-1.0.3.json") + `", "` + gotoURL(proxy, up.URL+"/cdn-cgi/speculation") + `"`
	if got != want {
		t.Errorf("Speculation-Rules\n got  %s\n want %s", got, want)
	}
	if !strings.Contains(resp.Header.Get("Crn-H"), "speculation-rules") {
		t.Errorf("the origin's value not carried for scripts: Crn-H %q", resp.Header.Get("Crn-H"))
	}
}

// TestE2E_SVGDocumentRewritten — an SVG loaded as a document (an
// <object>'s, Sec-Fetch-Dest: object) is rewritten as XML
// (spec/XmlDoc.agda; pokemon-vortex.com's logo loaded its @font-face from
// the origin): its style text, its hrefs (plain and xlink, any prefix),
// its script text; the XML bootstrap after the root's start tag; still
// well-formed. The same SVG as an image is left as sent.
func TestE2E_SVGDocumentRewritten(t *testing.T) {
	const svg = `<?xml version="1.0" encoding="UTF-8"?>` + "\n" +
		`<svg xmlns="http://www.w3.org/2000/svg" xmlns:l="http://www.w3.org/1999/xlink" width="9" height="9">` +
		`<style>@font-face { font-family: i; src: url('https://static.example/fonts/impact.ttf') }</style>` +
		`<image l:href="https://static.example/i.png" width="1" height="1"/><a href="https://static.example/p?a=1&amp;b=2"><text>t</text></a>` +
		`<script><![CDATA[ location.href.length < 5 && fetch("https://static.example/f") ]]></script></svg>`
	up := startInlineServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/svg+xml")
		_, _ = io.WriteString(w, svg)
	})
	proxy := startProxy(t)
	get := func(dest string) string {
		req, _ := http.NewRequest("GET", gotoURL(proxy, up.URL+"/logo.svg"), nil)
		req.Header.Set("Sec-Fetch-Dest", dest)
		resp, err := noCompressionClient().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return string(b)
	}
	body := get("object")
	if testing.Verbose() {
		t.Log(body)
	}
	for _, want := range []string{
		`url(` + `"` + gotoURL(proxy, "https://static.example/fonts/impact.ttf") + `"`, // the CSS rewriter quotes (spec/Css.agda)
		`l:href="` + gotoURL(proxy, "https://static.example/i.png") + `"`,
		`href="` + gotoURL(proxy, "https://static.example/p?a=1&b=2") + `"`,
		`<script xmlns="http://www.w3.org/2000/svg" href="/rewriter.js`,
	} {
		w := strings.ReplaceAll(want, "&", "&amp;")
		if !strings.Contains(body, w) && !strings.Contains(body, want) {
			t.Errorf("missing %s in\n%s", want, body)
		}
	}
	if strings.Contains(body, "'https://static.example/fonts/impact.ttf'") {
		t.Errorf("the font still names its origin:\n%s", body)
	}
	if err := xml.Unmarshal([]byte(body), new(struct{})); err != nil {
		t.Errorf("not well-formed: %v\n%s", err, body)
	}
	if image := get("image"); image != svg {
		t.Errorf("an SVG image changed:\n%s", image)
	}
}
