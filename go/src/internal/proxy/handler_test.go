package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

func cyranoPath(target string) string {
	u, _ := url.Parse(target)
	return "/cyrano/" + u.Scheme + "/" + u.Host + u.EscapedPath()
}

// startUpstream returns a stub origin server that echoes details about the
// request it received, so we can assert on what the proxy forwarded.
func startUpstream(t *testing.T) (*httptest.Server, *capturedRequest) {
	t.Helper()
	captured := &capturedRequest{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured.method = r.Method
		captured.path = r.URL.Path
		captured.host = r.Host
		captured.headers = r.Header.Clone()
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		w.Header().Set("Content-Security-Policy", "default-src 'self'")
		_, _ = w.Write([]byte("upstream-body"))
	}))
	t.Cleanup(srv.Close)
	return srv, captured
}

type capturedRequest struct {
	method  string
	path    string
	host    string
	headers http.Header
}

func TestProxy_ForwardsRequest(t *testing.T) {
	upstream, captured := startUpstream(t)
	h := New(Options{})

	target := upstream.URL + "/foo/bar"
	req := httptest.NewRequest("GET", cyranoPath(target), nil)
	req.Host = "localhost:9081"
	req.Header.Set("User-Agent", "go-test")
	req.Header.Set("Cookie", "should=not-leak")
	req.Header.Set("X-Forwarded-For", "1.2.3.4")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status: got %d want 200; body=%q", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "upstream-body" {
		t.Errorf("body: got %q", got)
	}
	if captured.path != "/foo/bar" {
		t.Errorf("upstream path: got %q want /foo/bar", captured.path)
	}
	if captured.method != "GET" {
		t.Errorf("upstream method: got %q", captured.method)
	}
	// Host header replaced with target host
	expectedHost := strings.TrimPrefix(upstream.URL, "http://")
	if captured.host != expectedHost {
		t.Errorf("upstream host: got %q want %q", captured.host, expectedHost)
	}
	// Cookies without a site-namespace prefix are filtered by the Director.
	// "should=not-leak" has no prefix, so it must not reach the upstream.
	if v := captured.headers.Get("Cookie"); strings.Contains(v, "should=not-leak") {
		t.Errorf("unprefixed cookie leaked upstream: Cookie=%q", v)
	}
	// X-Forwarded-For: suppressed via nil-sentinel; client-spoofed value must not appear.
	if v := captured.headers.Get("X-Forwarded-For"); strings.Contains(v, "1.2.3.4") {
		t.Errorf("client-supplied X-Forwarded-For leaked upstream: %q", v)
	}
}

func TestProxy_StripsProxyIncompatibleHeaders(t *testing.T) {
	upstream, _ := startUpstream(t)
	h := New(Options{})

	target := upstream.URL + "/"
	req := httptest.NewRequest("GET", cyranoPath(target), nil)
	req.Host = "localhost:9081"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	// These cannot be reconstituted for the proxy context and must be stripped.
	for _, name := range []string{
		"Strict-Transport-Security",
		"Alt-Svc",
	} {
		if v := rec.Header().Get(name); v != "" {
			t.Errorf("%s should be stripped from response, got %q", name, v)
		}
	}
}

func TestProxy_RejectsBadLoadParam(t *testing.T) {
	h := New(Options{})

	cases := []string{
		"/cyrano/",              // no scheme segment
		"/cyrano/http/",         // no host
		"/cyrano/ftp/nope.test/", // unsupported scheme
	}
	for _, p := range cases {
		req := httptest.NewRequest("GET", p, nil)
		req.Host = "localhost:9081"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			body, _ := io.ReadAll(rec.Body)
			t.Errorf("path=%q: status %d, want 400; body=%q", p, rec.Code, string(body))
		}
	}
}

func TestProxy_WebSocketSchemeNotImplemented(t *testing.T) {
	h := New(Options{})
	req := httptest.NewRequest("GET", "/cyrano/wss/example.com/socket", nil)
	req.Host = "localhost:9081"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotImplemented {
		t.Errorf("ws scheme: status %d, want 501", rec.Code)
	}
}

func TestProxy_BadGatewayOnUpstreamFailure(t *testing.T) {
	// Point at a definitely-closed port to force a connection refused.
	h := New(Options{})
	req := httptest.NewRequest("GET", "/cyrano/http/127.0.0.1:1/", nil)
	req.Host = "localhost:9081"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Errorf("upstream connect refused: status %d, want 502", rec.Code)
	}
}

// ── Location-redirect rewriting ─────────────────────────────────────────
//
// Regression for the "off-proxy escape" bug: if upstream sends a 30x with a
// Location header, our reverse-proxy used to pass it through verbatim, so
// the browser navigated straight to the origin and bypassed URL containment
// for the rest of the session. We now rewrite Location through urlrewrite
// so the redirect lands back on the proxy.

// startRedirectingUpstream returns a stub origin that emits a 302 with the
// configured Location header.
func startRedirectingUpstream(t *testing.T, location string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", location)
		w.WriteHeader(http.StatusFound)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func devProxyCfg() urlrewrite.ProxyConfig {
	return urlrewrite.ProxyConfig{
		PublicURL: &url.URL{Scheme: "http", Host: "localhost:9081"},
	}
}

func TestProxy_RewritesAbsoluteLocationRedirect(t *testing.T) {
	// Upstream redirects to a fully-qualified URL on a *different* origin —
	// the case that escapes the proxy if not rewritten (Wikimedia pattern).
	otherOrigin := "https://en.wiktionary.org/wiki/Wiktionary:Main_Page"
	upstream := startRedirectingUpstream(t, otherOrigin)

	h := New(Options{ProxyCfg: devProxyCfg()})
	target := upstream.URL + "/"
	req := httptest.NewRequest("GET", cyranoPath(target), nil)
	req.Host = "localhost:9081"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("status: got %d want %d", rec.Code, http.StatusFound)
	}
	got := rec.Header().Get("Location")
	want := "http://localhost:9081/cyrano/https/en.wiktionary.org/wiki/Wiktionary:Main_Page"
	if got != want {
		t.Errorf("Location:\n got  %q\n want %q", got, want)
	}
}

func TestProxy_RewritesRelativeLocationRedirect(t *testing.T) {
	// Upstream redirects to a relative path. The browser would resolve it
	// against the proxy origin (since we're on localhost:9081), landing at
	// localhost:9081/us with no ?goto= — broken page (theguardian pattern).
	// Rewrite resolves "/us" against the original upstream URL first, then
	// proxifies, so the browser stays in containment.
	upstream := startRedirectingUpstream(t, "/us")

	h := New(Options{ProxyCfg: devProxyCfg()})
	target := upstream.URL + "/"
	req := httptest.NewRequest("GET", cyranoPath(target), nil)
	req.Host = "localhost:9081"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("status: got %d want %d", rec.Code, http.StatusFound)
	}
	got := rec.Header().Get("Location")
	want := "http://localhost:9081" + cyranoPath(upstream.URL+"/us")
	if got != want {
		t.Errorf("Location:\n got  %q\n want %q", got, want)
	}
}

func TestProxy_RewritesContentLocationHeader(t *testing.T) {
	// Content-Location is used the same way (alternate URL for the
	// representation). Same rewrite policy.
	otherURL := "https://example.com/canonical"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Location", otherURL)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(upstream.Close)

	h := New(Options{ProxyCfg: devProxyCfg()})
	target := upstream.URL + "/"
	req := httptest.NewRequest("GET", cyranoPath(target), nil)
	req.Host = "localhost:9081"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	got := rec.Header().Get("Content-Location")
	want := "http://localhost:9081/cyrano/https/example.com/canonical"
	if got != want {
		t.Errorf("Content-Location:\n got  %q\n want %q", got, want)
	}
}

func TestProxy_LocationPassthroughWhenProxyCfgUnset(t *testing.T) {
	// With no PublicURL, the rewrite is disabled (test-only mode). Header
	// passes through verbatim.
	upstream := startRedirectingUpstream(t, "https://other.example/foo")

	h := New(Options{}) // no ProxyCfg
	target := upstream.URL + "/"
	req := httptest.NewRequest("GET", cyranoPath(target), nil)
	req.Host = "localhost:9081"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if got := rec.Header().Get("Location"); got != "https://other.example/foo" {
		t.Errorf("Location should pass through verbatim with empty ProxyCfg: got %q", got)
	}
}

// ── ServeHTTPWithTarget ─────────────────────────────────────────────────────

func TestServeHTTPWithTarget_ForwardsToExplicitTarget(t *testing.T) {
	upstream, captured := startUpstream(t)
	h := New(Options{})

	target, _ := url.Parse(upstream.URL + "/chunk-abc.js")
	// Simulate a bare-path request with no ?goto= param.
	req := httptest.NewRequest("GET", "/chunk-abc.js", nil)
	req.Host = "localhost:9081"

	rec := httptest.NewRecorder()
	h.ServeHTTPWithTarget(rec, req, target)

	if rec.Code != 200 {
		t.Fatalf("status: got %d want 200; body=%q", rec.Code, rec.Body.String())
	}
	if captured.path != "/chunk-abc.js" {
		t.Errorf("upstream path: got %q want /chunk-abc.js", captured.path)
	}
}

func TestServeHTTPWithTarget_BodyRewriterInvoked(t *testing.T) {
	called := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		_, _ = w.Write([]byte("var x = 1;"))
	}))
	t.Cleanup(upstream.Close)

	h := New(Options{
		BodyRewriter: func(resp *http.Response, target *url.URL) error {
			called = true
			return nil
		},
	})

	upstreamURL, _ := url.Parse(upstream.URL + "/app.js")
	req := httptest.NewRequest("GET", "/app.js", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTPWithTarget(rec, req, upstreamURL)

	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if !called {
		t.Error("BodyRewriter was not invoked for ServeHTTPWithTarget")
	}
}

func TestServeHTTPWithTarget_HeaderReconstitution(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		w.Header().Set("Alt-Svc", `h3=":443"; ma=86400`)
		// Permissions-Policy with upstream-origin allowlist (dell.com pattern):
		// unquoted origins are invalid per the current spec and cause browser
		// console warnings; the allowlist is meaningless through the proxy anyway.
		w.Header().Set("Permissions-Policy", "ch-dpr=(i.dell.com), ch-viewport-width=(i.dell.com)")
		w.Header().Set("Feature-Policy", "dpr i.dell.com")
		w.Header().Set("Content-Security-Policy", "default-src 'self'")
		w.Header().Set("X-Frame-Options", "deny")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		_, _ = w.Write([]byte("ok"))
	}))
	t.Cleanup(upstream.Close)

	h := New(Options{})
	target, _ := url.Parse(upstream.URL + "/data.txt")
	req := httptest.NewRequest("GET", "/data.txt", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTPWithTarget(rec, req, target)

	// Must be stripped — cannot be reconstituted for proxy context.
	if v := rec.Header().Get("Strict-Transport-Security"); v != "" {
		t.Errorf("HSTS should be stripped, got %q", v)
	}
	if v := rec.Header().Get("Alt-Svc"); v != "" {
		t.Errorf("Alt-Svc should be stripped, got %q", v)
	}
	if v := rec.Header().Get("Permissions-Policy"); v != "" {
		t.Errorf("Permissions-Policy should be stripped, got %q", v)
	}
	if v := rec.Header().Get("Feature-Policy"); v != "" {
		t.Errorf("Feature-Policy should be stripped, got %q", v)
	}

	// Must pass through — these use 'self' which the browser evaluates
	// relative to the proxy origin, so they work correctly as-is.
	if v := rec.Header().Get("Content-Security-Policy"); v == "" {
		t.Error("CSP should pass through, got empty")
	}
	if v := rec.Header().Get("X-Frame-Options"); v == "" {
		t.Error("X-Frame-Options should pass through, got empty")
	}
	if v := rec.Header().Get("Cross-Origin-Opener-Policy"); v == "" {
		t.Error("COOP should pass through, got empty")
	}
	if v := rec.Header().Get("Cross-Origin-Resource-Policy"); v == "" {
		t.Error("CORP should pass through, got empty")
	}
}

func TestServeHTTPWithTarget_CSPNoncesStripped(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		// Typical nonce-gated CSP (e.g. Cloudflare Turnstile widget pages).
		w.Header().Set("Content-Security-Policy",
			"script-src 'nonce-abc123' 'unsafe-eval'; style-src 'nonce-xyz'")
		_, _ = w.Write([]byte("<html><body>ok</body></html>"))
	}))
	t.Cleanup(upstream.Close)

	h := New(Options{})
	target, _ := url.Parse(upstream.URL + "/page")
	req := httptest.NewRequest("GET", "/page", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTPWithTarget(rec, req, target)

	got := rec.Header().Get("Content-Security-Policy")
	if strings.Contains(got, "nonce-") {
		t.Errorf("CSP nonce should be stripped, got %q", got)
	}
	if !strings.Contains(got, "'unsafe-inline'") {
		t.Errorf("CSP should contain 'unsafe-inline' after nonce strip, got %q", got)
	}
	if !strings.Contains(got, "'self'") {
		t.Errorf("CSP should contain 'self' after nonce strip, got %q", got)
	}
}

func TestDirector_TranslatesReferer(t *testing.T) {
	// CDN hotlink protection rejects requests whose Referer is the proxy
	// origin. The Director must translate proxy Referer → original page URL.
	upstream, cap := startUpstream(t)

	publicURL, _ := url.Parse("http://localhost:9081")
	proxyOrigin := publicURL.String() + "/cyrano/https/example.com/page"

	h := New(Options{
		ProxyCfg: urlrewrite.ProxyConfig{PublicURL: publicURL},
	})
	target, _ := url.Parse(upstream.URL + "/image.png")
	req := httptest.NewRequest("GET", "/image.png", nil)
	req.Header.Set("Referer", proxyOrigin)

	rec := httptest.NewRecorder()
	h.ServeHTTPWithTarget(rec, req, target)

	got := cap.headers.Get("Referer")
	if got != "https://example.com/page" {
		t.Errorf("upstream Referer = %q; want %q", got, "https://example.com/page")
	}
}

func TestDirector_LeavesNonProxyRefererUntouched(t *testing.T) {
	upstream, cap := startUpstream(t)

	publicURL, _ := url.Parse("http://localhost:9081")
	h := New(Options{
		ProxyCfg: urlrewrite.ProxyConfig{PublicURL: publicURL},
	})
	target, _ := url.Parse(upstream.URL + "/image.png")
	req := httptest.NewRequest("GET", "/image.png", nil)
	req.Header.Set("Referer", "https://example.com/somepage")

	rec := httptest.NewRecorder()
	h.ServeHTTPWithTarget(rec, req, target)

	got := cap.headers.Get("Referer")
	if got != "https://example.com/somepage" {
		t.Errorf("upstream Referer = %q; want unchanged %q", got, "https://example.com/somepage")
	}
}

func TestIsLoadRequest(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{"/cyrano/https/example.com/", true},
		{"/", false},
		{"/?other=1", false},
		{"/rewriter-status.json", false},
		{"/rewriter-extended-status.json", false},
	}
	for _, c := range cases {
		req := httptest.NewRequest("GET", c.path, nil)
		if got := IsLoadRequest(req); got != c.want {
			t.Errorf("IsLoadRequest(%q) = %v; want %v", c.path, got, c.want)
		}
	}
}

// ── cookie isolation ─────────────────────────────────────────────────────────

func TestCookieSiteKey(t *testing.T) {
	cases := []struct{ host, want string }{
		{"www.casio.com", "casio_com"},
		{"casio.com", "casio_com"},
		{"cdn.casio.com", "casio_com"},       // same eTLD+1
		{"stackoverflow.com", "stackoverflow_com"},
		{"www.bbc.co.uk", "bbc_co_uk"},       // two-part TLD
		{"localhost:9081", "localhost"},       // dev proxy host
		{"127.0.0.1", "127_0_0_1"},
	}
	for _, c := range cases {
		if got := cookieSiteKey(c.host); got != c.want {
			t.Errorf("cookieSiteKey(%q) = %q; want %q", c.host, got, c.want)
		}
	}
}

func TestRewriteOneCookie_PrefixesName(t *testing.T) {
	raw := "ak_bmsc=abc123; Path=/; Domain=.casio.com; Secure; SameSite=None"
	got := rewriteOneCookie(raw, true /*proxyHTTPS*/, "__crn__casio_com__")
	if !strings.HasPrefix(got, "__crn__casio_com__ak_bmsc=abc123") {
		t.Errorf("name not prefixed: %q", got)
	}
	if strings.Contains(got, "Domain=") {
		t.Errorf("Domain= not stripped: %q", got)
	}
}

func TestRewriteOneCookie_NoPrefixWhenEmpty(t *testing.T) {
	raw := "session=xyz; Path=/"
	got := rewriteOneCookie(raw, false, "")
	if !strings.HasPrefix(got, "session=xyz") {
		t.Errorf("unexpected change with empty prefix: %q", got)
	}
}

// startUpstreamWithSetCookie is like startUpstream but also sets a cookie
// in the response so we can verify it arrives at the browser prefixed.
func startUpstreamWithSetCookie(t *testing.T, cookieVal string) (*httptest.Server, *capturedRequest) {
	t.Helper()
	captured := &capturedRequest{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured.headers = r.Header.Clone()
		w.Header().Set("Set-Cookie", cookieVal)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	return srv, captured
}

func TestCookieIsolation_SetCookiePrefixedInResponse(t *testing.T) {
	upstream, _ := startUpstreamWithSetCookie(t, "ak_bmsc=secretval; Path=/; Domain=.casio.com")
	publicURL, _ := url.Parse("http://localhost:9081")
	h := New(Options{ProxyCfg: urlrewrite.ProxyConfig{PublicURL: publicURL}})

	target, _ := url.Parse(upstream.URL + "/")
	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTPWithTarget(rec, req, target)

	setCookies := rec.Result().Cookies()
	if len(setCookies) == 0 {
		t.Fatal("no Set-Cookie in response")
	}
	// The upstream host is the httptest server (127.0.0.1:port); its site key
	// is based on that host. We verify the name starts with the prefix token.
	if !strings.HasPrefix(setCookies[0].Name, "__crn__") {
		t.Errorf("Set-Cookie name not prefixed: %q", setCookies[0].Name)
	}
	if strings.Contains(setCookies[0].Name, "ak_bmsc") == false {
		t.Errorf("original cookie name missing: %q", setCookies[0].Name)
	}
}

func TestCookieIsolation_ForwardsMatchingPrefix(t *testing.T) {
	upstream, cap := startUpstream(t)
	upstreamURL, _ := url.Parse(upstream.URL)
	prefix := cookiePrefixFor(upstreamURL.Host)

	publicURL, _ := url.Parse("http://localhost:9081")
	h := New(Options{ProxyCfg: urlrewrite.ProxyConfig{PublicURL: publicURL}})

	target, _ := url.Parse(upstream.URL + "/")
	req := httptest.NewRequest("GET", "/", nil)
	// Simulate browser sending one matching cookie and one from a different site.
	req.Header.Set("Cookie", prefix+"session=abc; __crn__other_site__token=xyz")

	rec := httptest.NewRecorder()
	h.ServeHTTPWithTarget(rec, req, target)

	got := cap.headers.Get("Cookie")
	if got != "session=abc" {
		t.Errorf("upstream Cookie = %q; want %q", got, "session=abc")
	}
}

func TestCookieIsolation_DropsOtherSiteCookies(t *testing.T) {
	upstream, cap := startUpstream(t)

	publicURL, _ := url.Parse("http://localhost:9081")
	h := New(Options{ProxyCfg: urlrewrite.ProxyConfig{PublicURL: publicURL}})

	target, _ := url.Parse(upstream.URL + "/")
	req := httptest.NewRequest("GET", "/", nil)
	// Only cookies from a different site — none should reach this upstream.
	req.Header.Set("Cookie", "__crn__other_site__cf_clearance=abc; crnsct=proxy-internal")

	rec := httptest.NewRecorder()
	h.ServeHTTPWithTarget(rec, req, target)

	if got := cap.headers.Get("Cookie"); got != "" {
		t.Errorf("upstream received cookies it shouldn't: Cookie=%q", got)
	}
}

// ── server-side HttpOnly cookie jar ──────────────────────────────────────────

// startUpstreamMultiCookie returns a server that always emits the given
// Set-Cookie headers, and captures the Cookie header on each request.
func startUpstreamMultiCookie(t *testing.T, setCookies ...string) (*httptest.Server, *capturedRequest) {
	t.Helper()
	captured := &capturedRequest{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured.headers = r.Header.Clone()
		for _, sc := range setCookies {
			w.Header().Add("Set-Cookie", sc)
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	return srv, captured
}

func TestCookieJar_HttpOnlyCookieNotForwardedToBrowser(t *testing.T) {
	upstream, _ := startUpstreamMultiCookie(t,
		"session=secret; Path=/; HttpOnly",
		"pref=dark; Path=/",
	)
	publicURL, _ := url.Parse("http://localhost:9081")
	jar := NewSessionJar()
	h := New(Options{
		ProxyCfg:          urlrewrite.ProxyConfig{PublicURL: publicURL},
		CookieJar:         jar,
		SessionCookieName: "crnsct",
	})

	target, _ := url.Parse(upstream.URL + "/")
	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTPWithTarget(rec, req, target)

	// The HttpOnly "session" cookie must NOT appear in the browser response.
	for _, c := range rec.Result().Cookies() {
		if c.Name == "session" || strings.Contains(c.Name, "session") {
			// Allow only if it's the prefixed non-HttpOnly version
			if c.HttpOnly {
				t.Errorf("HttpOnly cookie forwarded to browser: %q", c.Name)
			}
		}
	}

	// The non-HttpOnly "pref" cookie MUST appear (prefixed).
	var foundPref bool
	for _, c := range rec.Result().Cookies() {
		if strings.Contains(c.Name, "pref") {
			foundPref = true
		}
	}
	if !foundPref {
		t.Error("non-HttpOnly cookie not forwarded to browser")
	}
}

func TestCookieJar_SessionCookieIssuedOnFirstResponse(t *testing.T) {
	upstream, _ := startUpstreamMultiCookie(t)
	publicURL, _ := url.Parse("http://localhost:9081")
	jar := NewSessionJar()
	h := New(Options{
		ProxyCfg:          urlrewrite.ProxyConfig{PublicURL: publicURL},
		CookieJar:         jar,
		SessionCookieName: "crnsct",
	})

	target, _ := url.Parse(upstream.URL + "/")
	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTPWithTarget(rec, req, target)

	var sessionCookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == "crnsct" {
			sessionCookie = c
		}
	}
	if sessionCookie == nil {
		t.Fatal("session cookie crnsct not set on first response")
	}
	if !sessionCookie.HttpOnly {
		t.Error("session cookie must be HttpOnly")
	}
	if sessionCookie.Value == "" {
		t.Error("session cookie must have a non-empty value")
	}
}

func TestCookieJar_JarCookiesForwardedToUpstream(t *testing.T) {
	// First request: upstream sets an HttpOnly cookie.
	// Second request: that cookie must be injected into the outgoing Cookie header.
	upstream, captured := startUpstreamMultiCookie(t,
		"session=tok123; Path=/; HttpOnly",
	)
	publicURL, _ := url.Parse("http://localhost:9081")
	jar := NewSessionJar()
	h := New(Options{
		ProxyCfg:          urlrewrite.ProxyConfig{PublicURL: publicURL},
		CookieJar:         jar,
		SessionCookieName: "crnsct",
	})
	target, _ := url.Parse(upstream.URL + "/")

	// First request — no session cookie yet; upstream sets HttpOnly session.
	req1 := httptest.NewRequest("GET", "/", nil)
	rec1 := httptest.NewRecorder()
	h.ServeHTTPWithTarget(rec1, req1, target)

	// Extract the crnsct session ID from the response.
	var sessionID string
	for _, c := range rec1.Result().Cookies() {
		if c.Name == "crnsct" {
			sessionID = c.Value
		}
	}
	if sessionID == "" {
		t.Fatal("no crnsct session cookie on first response")
	}

	// Second request — browser echoes crnsct; jar must inject session=tok123.
	req2 := httptest.NewRequest("GET", "/", nil)
	req2.Header.Set("Cookie", "crnsct="+sessionID)
	rec2 := httptest.NewRecorder()
	h.ServeHTTPWithTarget(rec2, req2, target)

	upstreamCookie := captured.headers.Get("Cookie")
	if !strings.Contains(upstreamCookie, "session=tok123") {
		t.Errorf("jar cookie not injected into upstream request; Cookie=%q", upstreamCookie)
	}
}

func TestCookieJar_SessionCookieNotReissuedWhenPresent(t *testing.T) {
	upstream, _ := startUpstreamMultiCookie(t)
	publicURL, _ := url.Parse("http://localhost:9081")
	jar := NewSessionJar()
	h := New(Options{
		ProxyCfg:          urlrewrite.ProxyConfig{PublicURL: publicURL},
		CookieJar:         jar,
		SessionCookieName: "crnsct",
	})
	target, _ := url.Parse(upstream.URL + "/")

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Cookie", "crnsct=existing-id-abc")
	rec := httptest.NewRecorder()
	h.ServeHTTPWithTarget(rec, req, target)

	for _, c := range rec.Result().Cookies() {
		if c.Name == "crnsct" {
			t.Errorf("crnsct session cookie should not be re-issued when already present, got %q", c.Value)
		}
	}
}
