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

// TestServeHTTP_PATProbeShortCircuits pins the Cloudflare Privacy Access Token
// (RFC 9577) behaviour: the proxy answers /cdn-cgi/challenge-platform/h/b/pat/
// probes with a bare 401 and — critically — NO WWW-Authenticate header, so the
// browser's PAT interceptor never engages and Cloudflare's challenge JS falls
// back to the (solvable) Turnstile path. A regression that emitted a
// PrivateToken challenge here would re-arm the hopeless PAT flow on Safari.
func TestServeHTTP_PATProbeShortCircuits(t *testing.T) {
	h := New(Options{})

	// No upstream needed: the short-circuit fires before any dial.
	req := httptest.NewRequest("GET",
		cyranoPath("https://claude.ai/cdn-cgi/challenge-platform/h/b/pat/some/token"), nil)
	req.Host = "localhost:9081"

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
	if wa := rec.Header().Get("WWW-Authenticate"); wa != "" {
		t.Errorf("WWW-Authenticate must be absent (would re-arm PAT), got %q", wa)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("body must be empty, got %q", rec.Body.String())
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

// TestServeHTTPWithTarget_PATProbeShortCircuits guards the hoisted short-circuit:
// bare-path challenge requests (blob workers with no Referer, routed via
// session origin) go through ServeHTTPWithTarget → serveTarget, which must also
// short-circuit the hopeless PAT probe instead of proxying it upstream.
func TestServeHTTPWithTarget_PATProbeShortCircuits(t *testing.T) {
	h := New(Options{})

	target := &url.URL{
		Scheme: "https",
		Host:   "claude.ai",
		Path:   "/cdn-cgi/challenge-platform/h/b/pat/some/token",
	}
	req := httptest.NewRequest("GET", "http://localhost:9081"+target.Path, nil)
	req.Host = "localhost:9081"

	rec := httptest.NewRecorder()
	h.ServeHTTPWithTarget(rec, req, target)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
	if wa := rec.Header().Get("WWW-Authenticate"); wa != "" {
		t.Errorf("WWW-Authenticate must be absent, got %q", wa)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("body must be empty, got %q", rec.Body.String())
	}
}
