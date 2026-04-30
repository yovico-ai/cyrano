package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/b64u"
	"github.com/yovico/cyrano/internal/urlrewrite"
)

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
	req := httptest.NewRequest("GET", "/?goto="+b64u.Encode(target), nil)
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
	// Cookies are forwarded upstream so challenge-clearance cookies
	// (cf_clearance, aws-waf-token) reach the upstream server.
	// (No assertion here — the key behaviour is that they are NOT stripped.)
	// X-Forwarded-For: httputil.ReverseProxy auto-appends the request's
	// RemoteAddr after our Director runs, so the header isn't empty upstream.
	// What we DO want to assert is that the client's spoofed "1.2.3.4" was
	// dropped before the auto-append.
	if v := captured.headers.Get("X-Forwarded-For"); strings.Contains(v, "1.2.3.4") {
		t.Errorf("client-supplied X-Forwarded-For leaked upstream: %q", v)
	}
}

func TestProxy_StripsDangerousResponseHeaders(t *testing.T) {
	upstream, _ := startUpstream(t)
	h := New(Options{})

	target := upstream.URL + "/"
	req := httptest.NewRequest("GET", "/?goto="+b64u.Encode(target), nil)
	req.Host = "localhost:9081"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	for _, name := range []string{
		"Strict-Transport-Security",
		"Content-Security-Policy",
	} {
		if v := rec.Header().Get(name); v != "" {
			t.Errorf("%s should be stripped from response, got %q", name, v)
		}
	}
}

func TestProxy_RejectsBadLoadParam(t *testing.T) {
	h := New(Options{})

	cases := []string{
		"",                // missing
		"!!not-base64!!",  // invalid b64
		b64u.Encode("ftp://nope.test/"),  // unsupported scheme
		b64u.Encode("not a url at all"),  // unparseable
	}
	for _, p := range cases {
		req := httptest.NewRequest("GET", "/?goto="+p, nil)
		req.Host = "localhost:9081"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			body, _ := io.ReadAll(rec.Body)
			t.Errorf("goto=%q: status %d, want 400; body=%q", p, rec.Code, string(body))
		}
	}
}

func TestProxy_WebSocketSchemeNotImplemented(t *testing.T) {
	h := New(Options{})
	req := httptest.NewRequest("GET", "/?goto="+b64u.Encode("wss://example.com/socket"), nil)
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
	req := httptest.NewRequest("GET", "/?goto="+b64u.Encode("http://127.0.0.1:1/"), nil)
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
	req := httptest.NewRequest("GET", "/?goto="+b64u.Encode(target), nil)
	req.Host = "localhost:9081"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("status: got %d want %d", rec.Code, http.StatusFound)
	}
	got := rec.Header().Get("Location")
	want := "http://localhost:9081/?goto=" + b64u.Encode(otherOrigin)
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
	req := httptest.NewRequest("GET", "/?goto="+b64u.Encode(target), nil)
	req.Host = "localhost:9081"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("status: got %d want %d", rec.Code, http.StatusFound)
	}
	got := rec.Header().Get("Location")
	want := "http://localhost:9081/?goto=" + b64u.Encode(upstream.URL+"/us")
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
	req := httptest.NewRequest("GET", "/?goto="+b64u.Encode(target), nil)
	req.Host = "localhost:9081"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	got := rec.Header().Get("Content-Location")
	want := "http://localhost:9081/?goto=" + b64u.Encode(otherURL)
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
	req := httptest.NewRequest("GET", "/?goto="+b64u.Encode(target), nil)
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

func TestServeHTTPWithTarget_StripsSecurityHeaders(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		w.Header().Set("Content-Security-Policy", "default-src 'self'")
		_, _ = w.Write([]byte("ok"))
	}))
	t.Cleanup(upstream.Close)

	h := New(Options{})
	target, _ := url.Parse(upstream.URL + "/data.txt")
	req := httptest.NewRequest("GET", "/data.txt", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTPWithTarget(rec, req, target)

	if v := rec.Header().Get("Strict-Transport-Security"); v != "" {
		t.Errorf("HSTS should be stripped, got %q", v)
	}
	if v := rec.Header().Get("Content-Security-Policy"); v != "" {
		t.Errorf("CSP should be stripped, got %q", v)
	}
}

func TestDirector_TranslatesReferer(t *testing.T) {
	// CDN hotlink protection rejects requests whose Referer is the proxy
	// origin. The Director must translate proxy Referer → original page URL.
	upstream, cap := startUpstream(t)

	publicURL, _ := url.Parse("http://localhost:9081")
	proxyOrigin := publicURL.String() + "/?goto=" + b64u.Encode("https://example.com/page")

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
		{"/?goto=" + b64u.Encode("https://example.com/"), true},
		{"/", false},                                    // no goto=
		{"/?other=1", false},                            // wrong param
		{"/rewriter-status.json?goto=x", false},         // rewriter- prefix excluded
		{"/rewriter-extended-status.json?goto=x", false},
	}
	for _, c := range cases {
		req := httptest.NewRequest("GET", c.path, nil)
		if got := IsLoadRequest(req); got != c.want {
			t.Errorf("IsLoadRequest(%q) = %v; want %v", c.path, got, c.want)
		}
	}
}
