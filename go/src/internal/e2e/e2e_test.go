//go:build e2e

package e2e

import (
	"io"
	"net"
	"net/http"
	"strings"
	"testing"

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

// TestE2E_SetCookiePrefixed — Set-Cookie headers from the upstream must arrive
// at the browser with the site-namespace prefix on the cookie name.
func TestE2E_SetCookiePrefixed(t *testing.T) {
	upstream := startInlineServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "session", Value: "abc123", Path: "/"})
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ok"))
	})
	proxy := startProxy(t)

	resp := getViaRaw(t, proxy, upstream.URL+"/")
	resp.Body.Close()

	// The cookie lives in the browser's jar in cyrano's wire form
	// (spec/Cookies.agda; urlrewrite.Unwire), scoped to the origin's host.
	found := false
	for _, sc := range resp.Cookies() {
		if c, ok := urlrewrite.Unwire(sc.Name, sc.Value); ok && c.Name == "session" && c.Value == "abc123" && c.HostOnly && c.Domain == "127.0.0.1" {
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

// TestE2E_OrbBlocksCrossOriginData — a <script> to another origin whose
// response Chromium's ORB blocks (JSON here) is a network error natively;
// through the proxy every script is same-origin, so the proxy breaks the
// connection (spec/Orb.agda proxyBlocks; Lenovo's /leid/assign). Not for a
// same-origin script, one that is script, or one sent with
// Access-Control-Allow-Origin (the page's mode then decides).
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
	dest := "script"
	load := func(page, query string) error {
		u := strings.Replace(gotoURL(proxy, up.URL+"/leid/assign"+query), "/cyrano/http/", "/cyrano/http!js/", 1)
		req, _ := http.NewRequest("GET", u, nil)
		req.Header.Set("Sec-Fetch-Dest", dest)
		req.Header.Set("Sec-Fetch-Mode", "cors")
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
	if err := load(cross, ""); err == nil {
		t.Errorf("cross-origin JSON script: answered, want a broken connection")
	}
	// ACAO, a script, a redirect, same-origin, and no page of ours known
	// behind the request: the response.
	for _, c := range []struct{ page, query string }{{cross, "?acao=1"}, {cross, "?js=1"}, {cross, "?moved=1"}, {up.URL + "/p", ""}, {"", ""}} {
		if err := load(c.page, c.query); err != nil {
			t.Errorf("%q%s: %v, want the response", c.page, c.query, err)
		}
	}
	// Only a script: a fetch() of the same data gets it (CORS decides there).
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
