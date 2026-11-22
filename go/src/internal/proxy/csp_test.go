package proxy

import (
	"context"
	"github.com/yovico/cyrano/internal/urlrewrite"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestRewriteCSP(t *testing.T) {
	cases := []struct {
		name        string
		in          string
		proxyOrigin string
		want        string
	}{
		// ── Nonce stripping (proxyOrigin = "") ─────────────────────────────
		{
			name: "no nonce — untouched",
			in:   "default-src 'self'; script-src 'self' 'unsafe-eval'; connect-src 'self' blob: data:",
			want: "default-src 'self'; script-src 'self' 'unsafe-eval'; connect-src 'self' blob: data:",
		},
		{
			name: "a nonce is kept as written",
			in:   "script-src 'nonce-abc123'",
			want: "script-src 'nonce-abc123'",
		},
		{
			name: "nonce kept beside unsafe-eval",
			in:   "script-src 'nonce-6djLkOGMswdROm46dktQ8K' 'unsafe-eval'",
			want: "script-src 'nonce-6djLkOGMswdROm46dktQ8K' 'unsafe-eval'",
		},
		{
			name: "nonce kept beside unsafe-inline",
			in:   "script-src 'nonce-abc' 'unsafe-inline' 'unsafe-eval'",
			want: "script-src 'nonce-abc' 'unsafe-inline' 'unsafe-eval'",
		},
		{
			name: "nonce kept beside self",
			in:   "script-src 'self' 'nonce-abc'",
			want: "script-src 'self' 'nonce-abc'",
		},
		{
			name: "strict-dynamic kept with its nonce",
			in:   "script-src 'nonce-abc' 'strict-dynamic' 'unsafe-eval'",
			want: "script-src 'nonce-abc' 'strict-dynamic' 'unsafe-eval'",
		},
		{
			name: "multi-directive: only script-src touched",
			in:   "default-src 'self'; script-src 'nonce-xyz'; img-src *; connect-src 'self' blob: data:",
			want: "default-src 'self'; script-src 'nonce-xyz'; img-src *; connect-src 'self' blob: data:",
		},
		{
			name: "default-src nonce kept",
			in:   "default-src 'nonce-abc' 'unsafe-eval'; connect-src 'nonce-abc' 'unsafe-eval' blob: data:",
			want: "default-src 'nonce-abc' 'unsafe-eval'; connect-src 'nonce-abc' 'unsafe-eval' blob: data:",
		},
		{
			name: "style-src nonce kept",
			in:   "style-src 'nonce-abc'",
			want: "style-src 'nonce-abc'",
		},
		{
			name: "script-src-elem nonce kept",
			in:   "script-src-elem 'nonce-abc' 'self'",
			want: "script-src-elem 'nonce-abc' 'self'",
		},
		{
			name: "non-script directive with nonce-like token untouched",
			in:   "connect-src 'nonce-abc' blob: data:",
			want: "connect-src 'nonce-abc' blob: data:",
		},
		{
			name: "empty string",
			in:   "",
			want: "",
		},

		// ── Proxy origin injection ──────────────────────────────────────────
		{
			name:        "proxy origin added to script-src",
			in:          "script-src https://cdn.ampproject.org/",
			proxyOrigin: "https://proxy.example.com",
			want:        "script-src https://cdn.ampproject.org/ https://proxy.example.com",
		},
		{
			name:        "proxy origin added to every *-src directive",
			in:          "default-src 'self'; script-src https://cdn.example.com; img-src *; connect-src 'self'",
			proxyOrigin: "https://proxy.example.com",
			want:        "default-src 'self' https://proxy.example.com; script-src https://cdn.example.com https://proxy.example.com; img-src * https://proxy.example.com; connect-src 'self' https://proxy.example.com wss://proxy.example.com blob: data:",
		},
		{
			name:        "proxy origin not duplicated when already present",
			in:          "script-src https://cdn.example.com https://proxy.example.com",
			proxyOrigin: "https://proxy.example.com",
			want:        "script-src https://cdn.example.com https://proxy.example.com",
		},
		{
			name:        "non-src directives left unchanged; report-uri stripped",
			in:          "sandbox allow-scripts; report-uri /csp; script-src 'self'",
			proxyOrigin: "https://proxy.example.com",
			want:        "sandbox allow-scripts; script-src 'self' https://proxy.example.com",
		},
		{
			name:        "report-to stripped",
			in:          "script-src 'self'; report-to default",
			proxyOrigin: "https://proxy.example.com",
			want:        "script-src 'self' https://proxy.example.com",
		},
		{
			name:        "object-src 'none' not polluted with proxy origin",
			in:          "script-src 'self'; object-src 'none'",
			proxyOrigin: "https://proxy.example.com",
			want:        "script-src 'self' https://proxy.example.com; object-src 'none'",
		},
		{
			name:        "default-src 'none' not polluted with proxy origin",
			in:          "default-src 'none'; script-src 'self'",
			proxyOrigin: "https://proxy.example.com",
			want:        "default-src 'none'; script-src 'self' https://proxy.example.com",
		},
		{
			name:        "nonce kept and proxy origin added",
			in:          "script-src 'nonce-abc' https://cdn.ampproject.org/",
			proxyOrigin: "https://proxy.example.com",
			want:        "script-src 'nonce-abc' https://cdn.ampproject.org/ https://proxy.example.com",
		},

		// ── Trusted Types stripping ─────────────────────────────────────────
		// Trusted Types stay enforced; the runtime's own policy is admitted
		// (Cloudflare's challenge fails when its frame's policy is dropped).
		{
			name: "require-trusted-types-for stays",
			in:   "script-src 'self'; require-trusted-types-for 'script'",
			want: "script-src 'self'; require-trusted-types-for 'script'",
		},
		{
			name: "trusted-types admits the runtime's policy too",
			in:   "script-src 'self'; trusted-types default dompurify",
			want: "script-src 'self'; trusted-types default dompurify " + urlrewrite.TrustedTypesPolicy,
		},
		{
			name: "trusted-types 'none' admits only the runtime's policy",
			in:   "trusted-types 'none'; require-trusted-types-for 'script'",
			want: "trusted-types " + urlrewrite.TrustedTypesPolicy + "; require-trusted-types-for 'script'",
		},
		{
			// x.com: 'none' with 'report-sample' allows nothing; the proxy
			// origin beside it made the browser ignore the 'none'.
			name: "'none' 'report-sample' allows nothing: left as it is",
			in:   "script-src-attr 'none' 'report-sample'; object-src 'none' 'report-sample'",
			want: "script-src-attr 'none' 'report-sample'; object-src 'none' 'report-sample'",
		},
		{
			name: "both directives together",
			in:   "default-src 'self'; trusted-types default; require-trusted-types-for 'script'; script-src 'nonce-abc'",
			want: "default-src 'self'; trusted-types default " + urlrewrite.TrustedTypesPolicy + "; require-trusted-types-for 'script'; script-src 'nonce-abc'; connect-src 'self' blob: data:",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := rewriteCSP(tc.in, tc.proxyOrigin)
			if got != tc.want {
				t.Errorf("\n got:  %q\n want: %q", got, tc.want)
			}
		})
	}
}

func TestRewriteCSP_StripsHashSourcesSoUnsafeInlineApplies(t *testing.T) {
	in := "script-src 'sha256-AAAA' 'sha256-BBBB' 'unsafe-inline' 'self'; object-src 'none'"
	got := rewriteCSP(in, "http://localhost:9081")
	if strings.Contains(got, "sha256-") {
		t.Errorf("hash-sources must be stripped from script-src so 'unsafe-inline' takes effect; got %q", got)
	}
	if !strings.Contains(got, "'unsafe-inline'") {
		t.Errorf("'unsafe-inline' must remain so our injected bootstrap runs; got %q", got)
	}
	if !strings.Contains(got, "object-src 'none'") {
		t.Errorf("unrelated directives must be preserved; got %q", got)
	}
}

func TestRewriteCSP_HashPinnedFallsBack(t *testing.T) {
	// A hash is of the page's original inline script; the rewritten one cannot
	// match. Such a directive loses its hashes, nonces and strict-dynamic and
	// allows inline scripts instead.
	got := rewriteCSP("script-src 'sha256-AAAA' 'nonce-abc' 'strict-dynamic' https://cdn.example", "")
	if want := "script-src https://cdn.example 'unsafe-inline' 'self'"; got != want {
		t.Errorf("\n got:  %q\n want: %q", got, want)
	}
}

func TestScriptNonce(t *testing.T) {
	for _, c := range []struct {
		policies []string
		want     string
	}{
		{nil, ""},
		{[]string{"default-src 'self'"}, ""},
		{[]string{"default-src 'nonce-d'; script-src 'nonce-s' 'strict-dynamic'"}, "s"},
		{[]string{"script-src 'nonce-s'; script-src-elem 'nonce-e'"}, "e"},
		{[]string{"default-src 'nonce-d'; img-src *"}, "d"},
		{[]string{"default-src 'nonce-d'; script-src 'self'"}, ""}, // script-src governs and has none
		{[]string{"img-src *", "script-src 'nonce-second'"}, "second"},
	} {
		if got := ScriptNonce(c.policies); got != c.want {
			t.Errorf("ScriptNonce(%q) = %q, want %q", c.policies, got, c.want)
		}
	}
}

// frame-ancestors is judged against the real embedder, and the browser is
// told the verdict in the proxy's terms.
func TestJudgeFraming(t *testing.T) {
	mk := func(csp, xfo, parent string) *http.Response {
		req := httptest.NewRequest("GET", "https://accounts.google.com/frame", nil)
		if parent != "" {
			p, _ := url.Parse(parent)
			req = req.WithContext(context.WithValue(req.Context(), framedByKey{}, p))
		}
		h := http.Header{}
		if csp != "" {
			h.Set("Content-Security-Policy", csp)
		}
		if xfo != "" {
			h.Set("X-Frame-Options", xfo)
		}
		return &http.Response{Header: h, Request: req}
	}
	target, _ := url.Parse("https://accounts.google.com/frame")
	for _, c := range []struct{ csp, xfo, parent, wantCSP, wantXFO string }{
		{"frame-ancestors https://accounts.google.com", "", "https://accounts.google.com/signin", "frame-ancestors 'self'", ""},
		{"frame-ancestors https://accounts.google.com", "", "https://evil.example/", "frame-ancestors 'none'", ""},
		{"script-src 'self'; frame-ancestors 'self' https://*.example.com", "", "https://a.example.com/x", "script-src 'self'; frame-ancestors 'self'", ""},
		{"frame-ancestors 'none'", "", "https://accounts.google.com/", "frame-ancestors 'none'", ""},
		{"", "SAMEORIGIN", "https://other.example/", "", "DENY"},
		{"", "SAMEORIGIN", "https://accounts.google.com/a", "", "SAMEORIGIN"},
		{"frame-ancestors *", "DENY", "https://other.example/", "frame-ancestors 'self'", "DENY"},
		{"frame-ancestors https://x.example", "", "", "frame-ancestors https://x.example", ""}, // not framed: untouched
	} {
		resp := mk(c.csp, c.xfo, c.parent)
		judgeFraming(resp, target)
		if got := resp.Header.Get("Content-Security-Policy"); got != c.wantCSP {
			t.Errorf("%q framed by %q: CSP %q, want %q", c.csp, c.parent, got, c.wantCSP)
		}
		if got := resp.Header.Get("X-Frame-Options"); got != c.wantXFO {
			t.Errorf("%q framed by %q: XFO %q, want %q", c.xfo, c.parent, got, c.wantXFO)
		}
	}
}

func TestInlineScriptAllowed(t *testing.T) {
	for policy, want := range map[string]bool{
		"":                                  true,
		"img-src 'self'":                    true,
		"script-src 'self' https://a.test":  false, // appleid.apple.com, api.twitter.com
		"default-src 'self'":                false,
		"script-src 'self' 'unsafe-inline'": true,
		"script-src 'nonce-abc'":            true,
		"script-src 'sha256-xyz'":           true,
		"default-src 'none'; script-src-elem 'unsafe-inline'": true,
	} {
		if got := urlrewrite.InlineScriptAllowed([]string{policy}); got != want {
			t.Errorf("%q: %v, want %v", policy, got, want)
		}
	}
}
