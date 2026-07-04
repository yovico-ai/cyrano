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

func TestSecFetchSite(t *testing.T) {
	mustURL := func(s string) *url.URL {
		u, err := url.Parse(s)
		if err != nil {
			t.Fatalf("bad url %q: %v", s, err)
		}
		return u
	}
	cases := []struct {
		name      string
		initiator string
		target    string
		want      string
	}{
		{"same origin", "https://claude.ai", "https://claude.ai/cdn-cgi/x", "same-origin"},
		{"same origin with path on initiator ignored", "https://claude.ai", "https://claude.ai/", "same-origin"},
		{"cross site: claude.ai -> challenges.cloudflare.com", "https://claude.ai", "https://challenges.cloudflare.com/turnstile/api.js", "cross-site"},
		{"same site: sub.example.com -> api.example.com", "https://sub.example.com", "https://api.example.com/x", "same-site"},
		{"cross scheme is cross-site", "http://example.com", "https://example.com/x", "cross-site"},
		{"different port is cross (same-site, not same-origin)", "https://example.com:8443", "https://example.com/x", "same-site"},
		{"unparseable initiator returns empty", "not a url", "https://claude.ai/", ""},
		{"empty initiator returns empty", "", "https://claude.ai/", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := secFetchSite(tc.initiator, mustURL(tc.target))
			if got != tc.want {
				t.Errorf("secFetchSite(%q, %q) = %q, want %q", tc.initiator, tc.target, got, tc.want)
			}
		})
	}
}

func TestIsCloudflareChallengeTarget(t *testing.T) {
	mustURL := func(s string) *url.URL {
		u, _ := url.Parse(s)
		return u
	}
	cases := []struct {
		url  string
		want bool
	}{
		{"https://challenges.cloudflare.com/turnstile/v0/api.js", true},
		{"https://claude.ai/cdn-cgi/challenge-platform/h/b/fo/x", true},
		{"https://claude.ai/cdn-cgi/challenge-platform/h/b/turnstile/f/normal", true},
		{"https://claude.ai/", false},
		{"https://cdn.example.com/image.png", false},
		{"https://example.com/turnstile/notcloudflare", true}, // /turnstile/ path — accepted (conservative)
	}
	for _, tc := range cases {
		if got := isCloudflareChallengeTarget(mustURL(tc.url)); got != tc.want {
			t.Errorf("isCloudflareChallengeTarget(%q) = %v, want %v", tc.url, got, tc.want)
		}
	}
}

func TestDefaultPolicyReferer(t *testing.T) {
	mustURL := func(s string) *url.URL {
		u, err := url.Parse(s)
		if err != nil {
			t.Fatalf("bad url %q: %v", s, err)
		}
		return u
	}
	cases := []struct {
		name     string
		referer  string
		target   string
		wantVal  string
		wantKeep bool
	}{
		{"same-origin keeps full path+query", "https://challenges.cloudflare.com/turnstile/f/x?lang=auto", "https://challenges.cloudflare.com/cdn-cgi/fo", "https://challenges.cloudflare.com/turnstile/f/x?lang=auto", true},
		{"cross-origin trims to origin (strips token)", "https://claude.ai/?__cf_chl_rt_tk=SECRET", "https://challenges.cloudflare.com/turnstile/api.js", "https://claude.ai/", true},
		{"cross-site trims to origin", "https://claude.ai/some/path", "https://challenges.cloudflare.com/x", "https://claude.ai/", true},
		{"https->http downgrade drops referer", "https://claude.ai/x", "http://insecure.example.com/y", "", false},
		{"unparseable left as-is", "::not a url", "https://claude.ai/", "::not a url", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotVal, gotKeep := defaultPolicyReferer(tc.referer, mustURL(tc.target))
			if gotVal != tc.wantVal || gotKeep != tc.wantKeep {
				t.Errorf("defaultPolicyReferer(%q, %q) = (%q, %v), want (%q, %v)", tc.referer, tc.target, gotVal, gotKeep, tc.wantVal, tc.wantKeep)
			}
		})
	}
}
