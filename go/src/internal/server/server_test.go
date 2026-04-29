package server

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/config"
)

var testPublicURL = &url.URL{Scheme: "http", Host: "localhost:9081"}

// b64uEncode is a test-local copy of the proxy URL encoding so the test
// doesn't import the proxy package and create a circular dependency.
func b64uEncode(s string) string {
	return strings.NewReplacer("+", "-", "/", "_").Replace(
		strings.TrimRight(base64.StdEncoding.EncodeToString([]byte(s)), "="))
}

// ── inferOriginFromReferer ──────────────────────────────────────────────────

func TestInferOriginFromReferer_ValidReferer(t *testing.T) {
	req := httptest.NewRequest("GET", "/chunk-abc.js", nil)
	req.Header.Set("Referer",
		"http://localhost:9081/?goto="+b64uEncode("https://github.com/")+"")

	got := inferOriginFromReferer(req, testPublicURL)
	if got == nil {
		t.Fatal("expected non-nil origin, got nil")
	}
	if got.Scheme != "https" {
		t.Errorf("scheme: got %q want https", got.Scheme)
	}
	if got.Host != "github.com" {
		t.Errorf("host: got %q want github.com", got.Host)
	}
	if got.Path != "" {
		t.Errorf("returned origin should have no path, got %q", got.Path)
	}
}

func TestInferOriginFromReferer_NoReferer(t *testing.T) {
	req := httptest.NewRequest("GET", "/chunk.js", nil)
	if got := inferOriginFromReferer(req, testPublicURL); got != nil {
		t.Errorf("expected nil for missing Referer, got %v", got)
	}
}

func TestInferOriginFromReferer_DifferentHost(t *testing.T) {
	// Referer is from an external origin — must not trust it.
	req := httptest.NewRequest("GET", "/chunk.js", nil)
	req.Header.Set("Referer",
		"http://evil.com/?goto="+b64uEncode("https://github.com/"))
	if got := inferOriginFromReferer(req, testPublicURL); got != nil {
		t.Errorf("expected nil for foreign Referer host, got %v", got)
	}
}

func TestInferOriginFromReferer_NoLoadParam(t *testing.T) {
	req := httptest.NewRequest("GET", "/chunk.js", nil)
	req.Header.Set("Referer", "http://localhost:9081/")
	if got := inferOriginFromReferer(req, testPublicURL); got != nil {
		t.Errorf("expected nil when no goto= param, got %v", got)
	}
}

func TestInferOriginFromReferer_BadBase64(t *testing.T) {
	req := httptest.NewRequest("GET", "/chunk.js", nil)
	req.Header.Set("Referer", "http://localhost:9081/?goto=NOT!!VALID!!BASE64")
	if got := inferOriginFromReferer(req, testPublicURL); got != nil {
		t.Errorf("expected nil for bad base64, got %v", got)
	}
}

func TestInferOriginFromReferer_NonHTTPScheme(t *testing.T) {
	// Decoded target has a non-http/https scheme — must reject.
	req := httptest.NewRequest("GET", "/chunk.js", nil)
	req.Header.Set("Referer",
		"http://localhost:9081/?goto="+b64uEncode("file:///etc/passwd"))
	if got := inferOriginFromReferer(req, testPublicURL); got != nil {
		t.Errorf("expected nil for file:// scheme, got %v", got)
	}
}

func TestInferOriginFromReferer_CaseInsensitiveHost(t *testing.T) {
	pubURL := &url.URL{Scheme: "http", Host: "Proxy.Example.COM:9081"}
	req := httptest.NewRequest("GET", "/chunk.js", nil)
	req.Header.Set("Referer",
		"http://proxy.example.com:9081/?goto="+b64uEncode("https://target.com/"))
	got := inferOriginFromReferer(req, pubURL)
	if got == nil {
		t.Error("expected match for same host with different case")
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
	referer := "http://localhost:9081/?goto=" + b64uEncode(upstream.URL+"/") + ""
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
	// Upstream records the path it received.
	var gotPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/javascript")
		_, _ = w.Write([]byte("/* chunk */"))
	}))
	t.Cleanup(upstream.Close)

	upURL, _ := url.Parse(upstream.URL)

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

	// Build the Referer: a proxied page whose origin is our upstream.
	referer := "http://localhost:9081/?goto=" + b64uEncode(upstream.URL+"/") + ""

	req := httptest.NewRequest("GET", "/chunk-abc.js", nil)
	req.Host = "localhost:9081"
	req.Header.Set("Referer", referer)

	_ = upURL // referenced to keep import happy
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status %d; body=%q", rec.Code, rec.Body.String())
	}
	if gotPath != "/chunk-abc.js" {
		t.Errorf("upstream received path %q, want /chunk-abc.js", gotPath)
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
	req.Header.Set("Referer", "http://localhost:9081/?goto=aHR0cHM6Ly9leGFtcGxlLmNvbS8")

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
	// ?goto= requests must be proxied to the upstream, not served as static
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
	req := httptest.NewRequest("GET", "/?goto="+b64uEncode(target), nil)
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
