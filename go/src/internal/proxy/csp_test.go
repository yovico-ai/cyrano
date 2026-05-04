package proxy

import "testing"

func TestStripCSPNonces(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
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
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := stripCSPNonces(tc.in)
			if got != tc.want {
				t.Errorf("\n got:  %q\n want: %q", got, tc.want)
			}
		})
	}
}
