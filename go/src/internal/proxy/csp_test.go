package proxy

import "testing"

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
			in:   "default-src 'self'; script-src 'self' 'unsafe-eval'",
			want: "default-src 'self'; script-src 'self' 'unsafe-eval'",
		},
		{
			name: "nonce-only script-src gets self+unsafe-inline added",
			in:   "script-src 'nonce-abc123'",
			want: "script-src 'unsafe-inline' 'self'",
		},
		{
			name: "nonce stripped, existing unsafe-eval kept, self+unsafe-inline added",
			in:   "script-src 'nonce-6djLkOGMswdROm46dktQ8K' 'unsafe-eval'",
			want: "script-src 'unsafe-eval' 'unsafe-inline' 'self'",
		},
		{
			name: "nonce stripped, unsafe-inline already present — not duplicated",
			in:   "script-src 'nonce-abc' 'unsafe-inline' 'unsafe-eval'",
			want: "script-src 'unsafe-inline' 'unsafe-eval' 'self'",
		},
		{
			name: "nonce stripped, self already present — not duplicated",
			in:   "script-src 'self' 'nonce-abc'",
			want: "script-src 'self' 'unsafe-inline'",
		},
		{
			name: "strict-dynamic stripped alongside nonce",
			in:   "script-src 'nonce-abc' 'strict-dynamic' 'unsafe-eval'",
			want: "script-src 'unsafe-eval' 'unsafe-inline' 'self'",
		},
		{
			name: "multi-directive: only script-src touched",
			in:   "default-src 'self'; script-src 'nonce-xyz'; img-src *",
			want: "default-src 'self'; script-src 'unsafe-inline' 'self'; img-src *",
		},
		{
			name: "default-src nonce stripped",
			in:   "default-src 'nonce-abc' 'unsafe-eval'",
			want: "default-src 'unsafe-eval' 'unsafe-inline' 'self'",
		},
		{
			name: "style-src nonce stripped",
			in:   "style-src 'nonce-abc'",
			want: "style-src 'unsafe-inline' 'self'",
		},
		{
			name: "script-src-elem nonce stripped",
			in:   "script-src-elem 'nonce-abc' 'self'",
			want: "script-src-elem 'self' 'unsafe-inline'",
		},
		{
			name: "non-script directive with nonce-like token untouched",
			in:   "connect-src 'nonce-abc'",
			want: "connect-src 'nonce-abc'",
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
			want:        "default-src 'self' https://proxy.example.com; script-src https://cdn.example.com https://proxy.example.com; img-src * https://proxy.example.com; connect-src 'self' https://proxy.example.com",
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
			name:        "nonce stripped and proxy origin added together",
			in:          "script-src 'nonce-abc' https://cdn.ampproject.org/",
			proxyOrigin: "https://proxy.example.com",
			want:        "script-src https://cdn.ampproject.org/ 'unsafe-inline' 'self' https://proxy.example.com",
		},

		// ── Trusted Types stripping ─────────────────────────────────────────
		{
			name: "require-trusted-types-for stripped",
			in:   "script-src 'self'; require-trusted-types-for 'script'",
			want: "script-src 'self'",
		},
		{
			name: "trusted-types directive stripped",
			in:   "script-src 'self'; trusted-types default dompurify",
			want: "script-src 'self'",
		},
		{
			name: "both trusted-types directives stripped together",
			in:   "default-src 'self'; trusted-types default; require-trusted-types-for 'script'; script-src 'nonce-abc'",
			want: "default-src 'self'; script-src 'unsafe-inline' 'self'",
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
