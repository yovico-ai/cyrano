package proxy

import (
	"encoding/json"
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

// No header is dropped: HSTS passes (a browser ignores it over plain HTTP).
// (Alt-Svc and the carried originals: TestServeHTTPWithTarget_HeaderReconstitution.)
func TestProxy_NoHeaderIsDropped(t *testing.T) {
	upstream, _ := startUpstream(t)
	h := New(Options{})

	target := upstream.URL + "/"
	req := httptest.NewRequest("GET", cyranoPath(target), nil)
	req.Host = "localhost:9081"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if v := rec.Header().Get("Strict-Transport-Security"); v == "" {
		t.Errorf("Strict-Transport-Security should pass through")
	}
}

func TestProxy_RejectsBadLoadParam(t *testing.T) {
	h := New(Options{})

	cases := []string{
		"/cyrano/",               // no scheme segment
		"/cyrano/http/",          // no host
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

// An origin that cannot be reached gives the browser no response at all, as
// it would get going there directly (fetch rejects; a 502 would resolve).
// Over a real connection: it is closed without a status line.
func TestProxy_UnreachableOriginGivesNoResponse(t *testing.T) {
	h := New(Options{})
	srv := httptest.NewServer(h)
	defer srv.Close()
	req, _ := http.NewRequest("GET", srv.URL+"/cyrano/http/127.0.0.1:1/", nil)
	resp, err := http.DefaultTransport.RoundTrip(req)
	if err == nil {
		resp.Body.Close()
		t.Fatalf("got a response (%d); want the connection closed without one", resp.StatusCode)
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
		w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
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
	// Nothing is dropped. What the browser must not act on is changed…
	if v := rec.Header().Get("Alt-Svc"); v != "clear" {
		t.Errorf("Alt-Svc should be neutralized to clear, got %q", v)
	}
	if v := rec.Header().Get("Permissions-Policy"); v != "ch-dpr=(self), ch-viewport-width=(self)" {
		t.Errorf("Permissions-Policy should be translated to the proxy, got %q", v)
	}
	if v := rec.Header().Get("Feature-Policy"); v != "dpr 'self'" {
		t.Errorf("Feature-Policy should be translated to the proxy, got %q", v)
	}
	// … and the rest passes as the origin sent it.
	if v := rec.Header().Get("Strict-Transport-Security"); v == "" {
		t.Errorf("HSTS should pass through")
	}
	if v := rec.Header().Get("Cross-Origin-Embedder-Policy"); v != "require-corp" {
		t.Errorf("COEP should pass through, got %q", v)
	}
	if v := rec.Header().Get("Cross-Origin-Opener-Policy"); v != "same-origin" {
		t.Errorf("COOP should pass through, got %q", v)
	}
	// Scripts read the origin's values for everything that was changed.
	var orig map[string][]string
	if err := json.Unmarshal([]byte(rec.Header().Get(OriginalHeadersName)), &orig); err != nil {
		t.Fatalf("%s: %v (%q)", OriginalHeadersName, err, rec.Header().Get(OriginalHeadersName))
	}
	if got := orig["permissions-policy"]; len(got) != 1 || got[0] != "ch-dpr=(i.dell.com), ch-viewport-width=(i.dell.com)" {
		t.Errorf("original Permissions-Policy not carried: %v", orig)
	}
	if _, ok := orig["alt-svc"]; !ok {
		t.Errorf("original Alt-Svc not carried: %v", orig)
	}

	// Must pass through — these use 'self' which the browser evaluates
	// relative to the proxy origin, so they work correctly as-is.
	if v := rec.Header().Get("Content-Security-Policy"); v == "" {
		t.Error("CSP should pass through, got empty")
	}
	if v := rec.Header().Get("X-Frame-Options"); v == "" {
		t.Error("X-Frame-Options should pass through, got empty")
	}
	if v := rec.Header().Get("Cross-Origin-Resource-Policy"); v == "" {
		t.Error("CORP should pass through, got empty")
	}
}

func TestServeHTTPWithTarget_CSPNoncesKept(t *testing.T) {
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
	// A nonce authorizes a script whatever its URL; it is kept (cyrano's own
	// bootstrap scripts carry the same nonce).
	if !strings.Contains(got, "'nonce-abc123'") || !strings.Contains(got, "'nonce-xyz'") {
		t.Errorf("CSP nonces should be kept, got %q", got)
	}
	if strings.Contains(got, "'unsafe-inline'") {
		t.Errorf("CSP should not be loosened to 'unsafe-inline', got %q", got)
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

	// Cross-origin under the default policy: a direct browser sends the
	// page's origin only — never the proxy's URL (spec/Referrer.agda).
	got := cap.headers.Get("Referer")
	if got != "https://example.com/" {
		t.Errorf("upstream Referer = %q; want %q", got, "https://example.com/")
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
