package server

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/config"
	"github.com/yovico/cyrano/internal/urlrewrite"
)

var testPublicURL = &url.URL{Scheme: "http", Host: "localhost:9081"}

// cyranoURL returns the proxy URL for a target, using http://localhost:9081 as the proxy origin.
func cyranoURL(target string) string {
	u, _ := url.Parse(target)
	return "http://localhost:9081/cyrano/" + u.Scheme + "/" + u.Host + u.EscapedPath()
}

// ── refererRoute (spec/Route.agda) ──────────────────────────────────────────

func route(t *testing.T, pub *url.URL, target, referer string) string {
	t.Helper()
	req := httptest.NewRequest("GET", target, nil)
	if referer != "" {
		req.Header.Set("Referer", referer)
	}
	return refererRoute(req, urlrewrite.ProxyConfig{PublicURL: pub})
}

func TestRefererRoute_ValidReferer(t *testing.T) {
	if got := route(t, testPublicURL, "/chunk-abc.js?v=1", "http://localhost:9081/cyrano/https/github.com/"); got != "/cyrano/https/github.com/chunk-abc.js?v=1" {
		t.Errorf("got %q", got)
	}
}

func TestRefererRoute_NotRouted(t *testing.T) {
	for name, ref := range map[string]string{
		"none":             "",
		"foreign host":     "http://evil.com/cyrano/https/github.com/",
		"not proxified":    "http://localhost:9081/",
		"malformed":        "http://localhost:9081/cyrano/",
		"file scheme":      "http://localhost:9081/cyrano/file/etc/passwd",
		"ws scheme":        "http://localhost:9081/cyrano/wss/h.example/",
		"other proxy port": "http://localhost:9082/cyrano/https/github.com/",
	} {
		if got := route(t, testPublicURL, "/chunk.js", ref); got != "" {
			t.Errorf("%s: routed to %q", name, got)
		}
	}
}

func TestRefererRoute_CaseInsensitiveHost(t *testing.T) {
	pub := &url.URL{Scheme: "http", Host: "Proxy.Example.COM:9081"}
	if got := route(t, pub, "/chunk.js", "http://proxy.example.com:9081/cyrano/https/target.com/"); got == "" {
		t.Error("expected match for same host with different case")
	}
}

// The path is the browser's, byte for byte; the origin is read as unwrap
// reads it (userinfo dropped, the host segment as an authority).
func TestRefererRoute_PathAsSentOriginAsUnwrapped(t *testing.T) {
	if got := route(t, testPublicURL, "/a/%2e%2e/100%25.js?", "http://localhost:9081/cyrano/https/u:p@H.example:443/page"); got != "/cyrano/https/h.example/a/%252e%252e/100%2525.js?" {
		t.Errorf("got %q", got)
	}
}

// ── Referer routing integration ─────────────────────────────────────────────

func TestServer_RewriterJSNotProxiedViaReferer(t *testing.T) {
	// Even when a Referer header points at a proxied page (e.g. hard reload),
	// /rewriter.js must be served locally, not forwarded to the upstream origin.
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// If this handler is called, the test fails — rewriter.js was proxied.
		w.WriteHeader(http.StatusTeapot)
	}))
	t.Cleanup(upstream.Close)

	tmpDir := t.TempDir()
	clientDir := tmpDir + "/client"
	if err := os.MkdirAll(clientDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(clientDir+"/rewriter.js", []byte("/* rewriter */"), 0644); err != nil {
		t.Fatal(err)
	}

	cfg := &config.File{
		Servers: []config.Server{{Port: 9081}},
		VHosts: []config.VHost{{
			Hostnames:         []string{"localhost"},
			HTTPPort:          9081,
			Mode:              "webproxy",
			RewriterJSPath:    "/rewriter.js",
			HeadInjectionPath: "/head-injection",
			CookiesJSONPath:   "/cookies.json",
		}},
	}
	srv := New(cfg, tmpDir, nil)
	handler := srv.Handler()

	// Request /rewriter.js with a Referer pointing at a proxied upstream page.
	referer := cyranoURL(upstream.URL + "/")
	req := httptest.NewRequest("GET", "/rewriter.js", nil)
	req.Host = "localhost:9081"
	req.Header.Set("Referer", referer)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status %d; want 200 (served locally), body=%q", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "/* rewriter */" {
		t.Errorf("body %q; want local rewriter.js content", got)
	}
}

func TestServer_RefererRouting(t *testing.T) {
	// Bare-path request from a rewritten page must redirect to the canonical
	// /cyrano/<scheme>/<host><path> URL — not inline-proxy it — so the
	// browser address bar stays correct and client-side routing works.
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("/* chunk */"))
	}))
	t.Cleanup(upstream.Close)

	cfg := &config.File{
		Servers: []config.Server{{Port: 9081}},
		VHosts: []config.VHost{{
			Hostnames:         []string{"localhost"},
			HTTPPort:          9081,
			Mode:              "webproxy",
			RewriterJSPath:    "/rewriter.js",
			HeadInjectionPath: "/head-injection",
			CookiesJSONPath:   "/cookies.json",
		}},
	}
	srv := New(cfg, t.TempDir(), nil)
	handler := srv.Handler()

	upURL, _ := url.Parse(upstream.URL)
	referer := cyranoURL(upstream.URL + "/")

	req := httptest.NewRequest("GET", "/chunk-abc.js", nil)
	req.Host = "localhost:9081"
	req.Header.Set("Referer", referer)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusTemporaryRedirect {
		t.Fatalf("status %d; want 307, body=%q", rec.Code, rec.Body.String())
	}
	want := "http://localhost:9081/cyrano/http/" + upURL.Host + "/chunk-abc.js"
	if got := rec.Header().Get("Location"); got != want {
		t.Errorf("Location %q; want %q", got, want)
	}
}

func TestServer_RefererRouting_307_PreservesMethod(t *testing.T) {
	// Referer-based routing must use 307 (not 302) so POST method and body are
	// preserved when challenge scripts redirect their API calls. A 302 would
	// silently convert POST → GET and drop the body, breaking challenge submission.
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	}))
	t.Cleanup(upstream.Close)

	cfg := &config.File{
		Servers: []config.Server{{Port: 9081}},
		VHosts: []config.VHost{{
			Hostnames:         []string{"localhost"},
			HTTPPort:          9081,
			Mode:              "webproxy",
			RewriterJSPath:    "/rewriter.js",
			HeadInjectionPath: "/head-injection",
			CookiesJSONPath:   "/cookies.json",
		}},
	}
	srv := New(cfg, t.TempDir(), nil)
	handler := srv.Handler()

	referer := cyranoURL(upstream.URL + "/page")
	req := httptest.NewRequest("POST", "/cdn-cgi/challenge-platform/api/v1/report", strings.NewReader("token=abc"))
	req.Host = "localhost:9081"
	req.Header.Set("Referer", referer)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusTemporaryRedirect {
		t.Fatalf("status %d; want 307 to preserve POST method, body=%q", rec.Code, rec.Body.String())
	}
}

func TestServer_FaviconSilencedEvenWithReferer(t *testing.T) {
	// /favicon.ico is always answered with 204 — even when the request
	// carries a valid proxied-page Referer. Modern sites declare their icon
	// via <link rel="icon"> (which the HTML rewriter handles correctly); the
	// /favicon.ico fallback path frequently 404s on the upstream and produces
	// noise in the browser console, so we suppress it here.
	cfg := &config.File{
		Servers: []config.Server{{Port: 9081}},
		VHosts: []config.VHost{{
			Hostnames:         []string{"localhost"},
			HTTPPort:          9081,
			Mode:              "webproxy",
			RewriterJSPath:    "/rewriter.js",
			HeadInjectionPath: "/head-injection",
			CookiesJSONPath:   "/cookies.json",
		}},
	}
	srv := New(cfg, t.TempDir(), nil)
	handler := srv.Handler()

	req := httptest.NewRequest("GET", "/favicon.ico", nil)
	req.Host = "localhost:9081"
	req.Header.Set("Referer", "http://localhost:9081/cyrano/https/example.com/")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d; want 204 (silenced)", rec.Code)
	}
}

func TestServer_FaviconSilencedWithoutReferer(t *testing.T) {
	// /favicon.ico without a proxied-page Referer (landing page) → 204 No Content.
	cfg := &config.File{
		Servers: []config.Server{{Port: 9081}},
		VHosts: []config.VHost{{
			Hostnames:         []string{"localhost"},
			HTTPPort:          9081,
			Mode:              "webproxy",
			RewriterJSPath:    "/rewriter.js",
			HeadInjectionPath: "/head-injection",
			CookiesJSONPath:   "/cookies.json",
		}},
	}
	srv := New(cfg, t.TempDir(), nil)
	handler := srv.Handler()

	req := httptest.NewRequest("GET", "/favicon.ico", nil)
	req.Host = "localhost:9081"
	// No Referer header.

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("status %d; want 204 (silenced)", rec.Code)
	}
}

func TestServer_RoutesGotoRequest(t *testing.T) {
	// /cyrano/ requests must be proxied to the upstream, not served as static
	// files. This directly exercises the IsLoadRequest dispatch in Handler().
	var gotPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<html><head></head><body>hello</body></html>"))
	}))
	t.Cleanup(upstream.Close)

	cfg := &config.File{
		Servers: []config.Server{{Port: 9081}},
		VHosts: []config.VHost{{
			Hostnames:         []string{"localhost"},
			HTTPPort:          9081,
			Mode:              "webproxy",
			RewriterJSPath:    "/rewriter.js",
			HeadInjectionPath: "/head-injection",
			CookiesJSONPath:   "/cookies.json",
		}},
	}
	srv := New(cfg, t.TempDir(), nil)
	handler := srv.Handler()

	target := upstream.URL + "/some/page"
	u, _ := url.Parse(target)
	cyranoReqPath := "/cyrano/" + u.Scheme + "/" + u.Host + u.EscapedPath()
	req := httptest.NewRequest("GET", cyranoReqPath, nil)
	req.Host = "localhost:9081"

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status %d; body=%q", rec.Code, rec.Body.String())
	}
	if gotPath != "/some/page" {
		t.Errorf("upstream received path %q; want /some/page", gotPath)
	}
	// Response must contain the injected rewriter script, not the landing page.
	if !strings.Contains(rec.Body.String(), "rewriter.js") {
		t.Error("response missing rewriter.js injection; likely served landing page instead of proxying")
	}
}

// ── isChallengeHTML ──────────────────────────────────────────────────────────

func TestIsChallengeHTML_OldCfChlPath(t *testing.T) {
	if !isChallengeHTML([]byte(`<script src="/__cf_chl_abc/challenge.js"></script>`)) {
		t.Error("__cf_chl path should be detected as challenge HTML")
	}
}

func TestIsChallengeHTML_OldChallengePath(t *testing.T) {
	if !isChallengeHTML([]byte(`<script src="/__challenge_abc/challenge.js"></script>`)) {
		t.Error("__challenge_ path should be detected as challenge HTML")
	}
}

func TestIsChallengeHTML_ManagedChallenge(t *testing.T) {
	// Cloudflare managed/Turnstile challenge — references /cdn-cgi/challenge-platform/
	body := []byte(`<script>a.src = '/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=abc';</script>`)
	if !isChallengeHTML(body) {
		t.Error("managed challenge page with /cdn-cgi/challenge-platform/ should be detected")
	}
}

func TestIsChallengeHTML_NormalPage(t *testing.T) {
	if isChallengeHTML([]byte(`<html><body><p>Hello world</p></body></html>`)) {
		t.Error("normal HTML page should not be detected as challenge HTML")
	}
}

func TestIsChallengeHTML_PassiveJsdIsNotChallenge(t *testing.T) {
	// Cloudflare injects a passive telemetry script into NORMAL pages
	// (/cdn-cgi/challenge-platform/scripts/jsd/main.js). It must NOT be
	// classified as a challenge — otherwise the app page gets the minimal
	// challenge shim instead of the full $rewriter client and breaks.
	body := []byte(`<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script><div id="app">real app</div>`)
	if isChallengeHTML(body) {
		t.Error("passive jsd telemetry script must NOT be detected as a challenge page")
	}
}

func TestIsChallengeHTML_CfChlOptInterstitial(t *testing.T) {
	if !isChallengeHTML([]byte(`<script>window._cf_chl_opt={cType:'managed'};</script>`)) {
		t.Error("_cf_chl_opt interstitial config should be detected as challenge HTML")
	}
}

// ── isChallengeScript ────────────────────────────────────────────────────────

func TestIsChallengeScript_CdnCgiChallengePlatform(t *testing.T) {
	// Cloudflare challenge-platform scripts (orchestrate, jsd, etc.) are
	// JS-rewritten so that location.* accesses are wrapped via
	// $rewriter.wrap_get_location. The challenge page injects a minimal
	// $rewriter shim, so these scripts must NOT be excluded from rewriting.
	u, _ := url.Parse("https://www.wordreference.com/cdn-cgi/challenge-platform/scripts/jsd/main.js")
	if isChallengeScript(u) {
		t.Error("cdn-cgi/challenge-platform scripts should NOT be excluded from JS rewriting — they need wrap_get_location to see the upstream hostname")
	}
}

func TestIsChallengeScript_OldCfChlPattern(t *testing.T) {
	u, _ := url.Parse("https://example.com/__cf_chl_opt/challenge.js")
	if !isChallengeScript(u) {
		t.Error("__cf_chl pattern should be detected as challenge script")
	}
}

func TestIsChallengeScript_OldChallengePattern(t *testing.T) {
	u, _ := url.Parse("https://example.com/__challenge_abc123/challenge.js")
	if !isChallengeScript(u) {
		t.Error("__challenge_ pattern should be detected as challenge script")
	}
}

func TestIsChallengeScript_NormalJS(t *testing.T) {
	u, _ := url.Parse("https://example.com/static/app.js")
	if isChallengeScript(u) {
		t.Error("normal JS should not be detected as challenge script")
	}
}

func TestIsChallengeScript_AkamaiScript(t *testing.T) {
	u, _ := url.Parse("https://www.casio.com/nFP9UMOZ6T/Wwr_/M1hZSI?v=12345678-1234-1234-1234-123456789abc&t=1234567")
	if !isChallengeScript(u) {
		t.Error("Akamai Bot Manager script should be detected as challenge script")
	}
}

func TestIsChallengeScript_AkamaiScript_NoV(t *testing.T) {
	u, _ := url.Parse("https://www.casio.com/nFP9UMOZ6T/Wwr_/M1hZSI?t=1234567")
	if isChallengeScript(u) {
		t.Error("random-path script without UUID v= should not match Akamai pattern")
	}
}

func TestIsChallengeScript_AkamaiScript_HasExtension(t *testing.T) {
	u, _ := url.Parse("https://www.casio.com/nFP9UMOZ6T/Wwr_.js?v=12345678-1234-1234-1234-123456789abc")
	if isChallengeScript(u) {
		t.Error("path with file extension should not match Akamai pattern")
	}
}

// ── isChallengeHost ──────────────────────────────────────────────────────────

func TestIsChallengeHost_CloudflareTurnstile(t *testing.T) {
	if !isChallengeHost("challenges.cloudflare.com") {
		t.Error("challenges.cloudflare.com should be detected as a challenge host")
	}
}

func TestIsChallengeHost_CaseInsensitive(t *testing.T) {
	if !isChallengeHost("Challenges.Cloudflare.Com") {
		t.Error("isChallengeHost should be case-insensitive")
	}
}

func TestIsChallengeHost_RegularHost(t *testing.T) {
	if isChallengeHost("www.example.com") {
		t.Error("regular host should not be a challenge host")
	}
}

// ── isChallengeJSPath / empty-JS fallback ────────────────────────────────────

func TestIsChallengeJSPath_Match(t *testing.T) {
	if !isChallengeJSPath("/cdn-cgi/challenge-platform/scripts/jsd/main.js") {
		t.Error("cdn-cgi/challenge-platform/*.js should match")
	}
}

func TestIsChallengeJSPath_NoMatch_NormalJS(t *testing.T) {
	if isChallengeJSPath("/static/app.js") {
		t.Error("normal JS should not match")
	}
}

func TestIsChallengeJSPath_NoMatch_NonJS(t *testing.T) {
	if isChallengeJSPath("/cdn-cgi/challenge-platform/scripts/jsd/data.json") {
		t.Error("non-JS cdn-cgi path should not match")
	}
}

func makeTestServer(t *testing.T) http.Handler {
	t.Helper()
	cfg := &config.File{
		Servers: []config.Server{{Port: 9081}},
		VHosts: []config.VHost{{
			Hostnames:         []string{"localhost"},
			HTTPPort:          9081,
			Mode:              "sslvpn",
			RewriterJSPath:    "/rewriter.js",
			HeadInjectionPath: "/head-injection",
			CookiesJSONPath:   "/cookies.json",
		}},
	}
	return New(cfg, t.TempDir(), nil).Handler()
}

// Regression for the ServeMux double-slash collapse bug:
// Cloudflare Image Resizing URLs embed a full URL in the path, e.g.:
//
//	/cyrano/https/files.example.com/cdn-cgi/image/<opts>/https://origin.com/img.jpg
//
// net/http.ServeMux calls path.Clean which collapses `//` → `/`, issuing a
// 301 to .../https:/origin.com/... — a broken URL. The handler must NOT use
// ServeMux so these paths are dispatched as-is.
func TestHandler_NoDoubleslashRedirect(t *testing.T) {
	handler := makeTestServer(t)

	// Path contains `//` from the embedded `https://` inside the proxy URL.
	req := httptest.NewRequest("GET",
		"/cyrano/https/files.example.com/cdn-cgi/image/width=800/https://origin.example.com/img.jpg",
		nil)
	req.Host = "localhost"
	w := httptest.NewRecorder()
	func() {
		// The host does not resolve: the proxy closes the connection
		// without a response (http.ErrAbortHandler), as unreachable origins do.
		defer func() {
			if r := recover(); r != nil && r != http.ErrAbortHandler {
				panic(r)
			}
		}()
		handler.ServeHTTP(w, req)
	}()

	// Must NOT be a 301 redirect that collapses // → /
	if w.Code == http.StatusMovedPermanently {
		loc := w.Header().Get("Location")
		t.Errorf("handler issued 301 redirect to %q (double-slash collapsed by ServeMux)", loc)
	}
}

func TestServer_CdnCgiChallengeFallback_EmptyJS(t *testing.T) {
	cfg := &config.File{
		Servers: []config.Server{{Port: 9081}},
		VHosts: []config.VHost{{
			Hostnames:         []string{"localhost"},
			HTTPPort:          9081,
			Mode:              "sslvpn",
			RewriterJSPath:    "/rewriter.js",
			HeadInjectionPath: "/head-injection",
			CookiesJSONPath:   "/cookies.json",
		}},
	}
	srv := New(cfg, t.TempDir(), nil)
	handler := srv.Handler()

	req := httptest.NewRequest("GET", "/cdn-cgi/challenge-platform/scripts/jsd/main.js", nil)
	req.Host = "localhost:9081"
	// No Referer — simulates request from about:blank sandbox.
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	ct := w.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "application/javascript") {
		t.Errorf("expected application/javascript Content-Type, got %q", ct)
	}
	if body := w.Body.String(); body != "" {
		t.Errorf("expected empty body, got %q", body)
	}
}
