package urlrewrite

import (
	"net/url"
	"testing"
)

func TestUnproxyQueryValues(t *testing.T) {
	cfg := ProxyConfig{PublicURL: &url.URL{Scheme: "http", Host: "localhost:9081"}}
	prox := url.QueryEscape("http://localhost:9081/cyrano/https/site.example/p?x=1")
	for _, c := range []struct{ in, want string }{
		{"", ""},
		{"b=2&a=1&z=%7e", "b=2&a=1&z=%7e"}, // untouched, order and escapes kept
		{"b=%7e&force_referer=" + prox + "&a", "b=%7e&force_referer=" + url.QueryEscape("https://site.example/p?x=1") + "&a"},
		{"u=" + url.QueryEscape("http://localhost:9081/not-proxified"), "u=" + url.QueryEscape("http://localhost:9081/not-proxified")},
		{"u=%zz&cyrano=1", "u=%zz&cyrano=1"},
	} {
		if got := UnproxyQueryValues(c.in, cfg); got != c.want {
			t.Errorf("UnproxyQueryValues(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSplitWSOrigin(t *testing.T) {
	o := url.QueryEscape("https://page.example")
	for _, c := range []struct {
		in, rest, origin string
		had              bool
	}{
		{WSOriginParam + "=" + o, "", "https://page.example", false},
		{"&" + WSOriginParam + "=" + o, "", "https://page.example", true}, // the page's URL ended in a bare "?"
		{"a=1&b=%7e&" + WSOriginParam + "=" + o, "a=1&b=%7e", "https://page.example", true},
		{"a=1", "a=1", "", true},
		{WSOriginParam + "=" + o + "&a=1", WSOriginParam + "=" + o + "&a=1", "", true}, // not last: the page's own
		{"a=1&" + WSOriginParam + "=javascript%3Ax", "a=1", "", true},
	} {
		rest, origin, had := SplitWSOrigin(c.in)
		if rest != c.rest || origin != c.origin || had != c.had {
			t.Errorf("SplitWSOrigin(%q) = %q, %q, %v; want %q, %q, %v", c.in, rest, origin, had, c.rest, c.origin, c.had)
		}
	}
}
