package urlrewrite

import "testing"

// SchemefulSite: "scheme://registrable-domain" (HTML "schemeful site"),
// the host itself where there is no registrable domain, "" when the URL
// does not parse. The registrable domain is the public suffix list's
// eTLD+1 (registrable, as SecFetchSite uses it).
func TestSchemefulSite(t *testing.T) {
	cases := []struct{ in, want string }{
		// eTLD+1 under a multi-label public suffix.
		{"https://a.b.example.co.uk/x", "https://example.co.uk"},
		{"https://example.co.uk/", "https://example.co.uk"},
		{"https://www.example.com/path?q#f", "https://example.com"},
		// The scheme is part of the site; port, userinfo, path are not.
		{"http://www.example.com:8080/", "http://example.com"},
		{"https://user:pw@sub.example.com/", "https://example.com"},
		{"wss://chat.example.com/socket", "wss://example.com"},
		// Host case is normalised by the URL parser.
		{"https://WWW.Example.COM/", "https://example.com"},
		// No registrable domain: the host itself.
		{"https://192.168.1.10/a", "https://192.168.1.10"},
		{"http://127.0.0.1:9081/", "http://127.0.0.1"},
		{"https://[2001:db8::1]/a", "https://[2001:db8::1]"},
		{"https://localhost/", "https://localhost"},
		{"https://com/", "https://com"},
		{"https://co.uk/", "https://co.uk"},
		// Chromium keeps a space in a host, percent-encoded (whatwg.go chromiumHost).
		{"https://exa mple.com/", "https://exa%20mple.com"},
		// Does not parse.
		{"not a url", ""},
		{"", ""},
		{"https://exa|mple.com/", ""}, // a forbidden host code point
		{"https://999.1.1.1/", ""},    // ends in a number, not an IPv4 address
		{"http://[::1/", ""},
	}
	for _, c := range cases {
		if got := SchemefulSite(c.in); got != c.want {
			t.Errorf("SchemefulSite(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// Same site ⇔ equal SchemefulSite, for the pairs SecFetchSite calls
// same-site or same-origin (both on the same registrable domain and scheme).
func TestSchemefulSite_AgreesWithSecFetchSite(t *testing.T) {
	urls := []string{
		"https://a.example.co.uk/", "https://b.example.co.uk/x", "https://example.co.uk/",
		"http://a.example.co.uk/", "https://other.co.uk/", "https://a.example.com/",
		"https://192.168.1.10/", "https://192.168.1.11/", "https://localhost/",
	}
	for _, a := range urls {
		for _, b := range urls {
			sameSite := SecFetchSite(a, b) != "cross-site"
			if eq := SchemefulSite(a) == SchemefulSite(b); eq != sameSite {
				t.Errorf("%s vs %s: SchemefulSite equal = %v, SecFetchSite = %q", a, b, eq, SecFetchSite(a, b))
			}
		}
	}
}
