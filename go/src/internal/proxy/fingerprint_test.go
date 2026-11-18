package proxy

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// TestDirector_ForwardsAcceptEncodingVerbatim verifies the proxy forwards the
// browser's Accept-Encoding unchanged — including zstd. Stripping zstd (as the
// proxy used to) is a fingerprint mismatch against the Chrome UA/TLS it now
// presents.
func TestDirector_ForwardsAcceptEncodingVerbatim(t *testing.T) {
	upstream, captured := startUpstream(t)
	h := New(Options{})

	req := httptest.NewRequest("GET", cyranoPath(upstream.URL+"/x"), nil)
	req.Host = "localhost:9081"
	req.Header.Set("Accept-Encoding", "gzip, deflate, br, zstd")

	h.ServeHTTP(httptest.NewRecorder(), req)

	if got := captured.headers.Get("Accept-Encoding"); got != "gzip, deflate, br, zstd" {
		t.Errorf("Accept-Encoding forwarded = %q, want verbatim %q", got, "gzip, deflate, br, zstd")
	}
}

// TestDirector_AcceptEncodingFallback verifies that when the client sends no
// Accept-Encoding, the proxy substitutes Chrome's full set rather than a
// tell-tale "gzip only".
func TestDirector_AcceptEncodingFallback(t *testing.T) {
	upstream, captured := startUpstream(t)
	h := New(Options{})

	req := httptest.NewRequest("GET", cyranoPath(upstream.URL+"/x"), nil)
	req.Host = "localhost:9081"
	req.Header.Del("Accept-Encoding")

	h.ServeHTTP(httptest.NewRecorder(), req)

	if got := captured.headers.Get("Accept-Encoding"); got != "gzip, deflate, br, zstd" {
		t.Errorf("Accept-Encoding fallback = %q, want %q", got, "gzip, deflate, br, zstd")
	}
}

// TestServeHTTP_PATProbeForwarded verifies Cloudflare Privacy Access Token
// (RFC 9577) probes are forwarded to the upstream unchanged rather than
// short-circuited with a fabricated bare 401. Forwarding hands the browser the
// exact response a direct browser sees (a real 401 with WWW-Authenticate:
// PrivateToken), which desktop Chrome ignores before falling back to Turnstile;
// a fabricated bare 401 is a response no direct browser produces and stood out
// as the one failing request in a clean session.
func TestServeHTTP_PATProbeForwarded(t *testing.T) {
	upstream, captured := startUpstream(t)
	h := New(Options{})

	req := httptest.NewRequest("GET",
		cyranoPath(upstream.URL+"/cdn-cgi/challenge-platform/h/b/pat/some/token"), nil)
	req.Host = "localhost:9081"

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if captured.path != "/cdn-cgi/challenge-platform/h/b/pat/some/token" {
		t.Errorf("PAT probe was not forwarded upstream; captured path = %q", captured.path)
	}
}

// TestServeHTTP_NonPATChallengePathProxied is the negative control: a normal
// challenge-platform path (not the /pat/ probe) must NOT be short-circuited.
func TestServeHTTP_NonPATChallengePathProxied(t *testing.T) {
	upstream, captured := startUpstream(t)
	h := New(Options{})

	req := httptest.NewRequest("GET",
		cyranoPath(upstream.URL+"/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"), nil)
	req.Host = "localhost:9081"

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code == http.StatusUnauthorized {
		t.Fatalf("non-PAT challenge path was short-circuited (401); should be proxied")
	}
	if captured.path == "" {
		t.Error("expected the request to reach the upstream, but it did not")
	}
}

// TestServeHTTPWithTarget_PATProbeForwarded is the bare-path counterpart (blob
// workers with no Referer, routed via session origin, go through
// ServeHTTPWithTarget → serveTarget): the /pat/ probe must be forwarded
// upstream here too, not short-circuited.
func TestServeHTTPWithTarget_PATProbeForwarded(t *testing.T) {
	upstream, captured := startUpstream(t)
	h := New(Options{})

	target, _ := url.Parse(upstream.URL + "/cdn-cgi/challenge-platform/h/b/pat/some/token")
	req := httptest.NewRequest("GET", "http://localhost:9081"+target.Path, nil)
	req.Host = "localhost:9081"

	rec := httptest.NewRecorder()
	h.ServeHTTPWithTarget(rec, req, target)

	if captured.path != "/cdn-cgi/challenge-platform/h/b/pat/some/token" {
		t.Errorf("PAT probe (bare-path) was not forwarded upstream; captured path = %q", captured.path)
	}
}
