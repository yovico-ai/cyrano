package proxy

import (
	"net/http/httptest"
	"net/url"
	"testing"
)

// A cross-site frame's requests are third-party even to the top-level
// site, and so are an A-B-A frame's (recorded in Chromium); the header was
// left off when the target's site was the top-level one.
func TestStorageAccess_CrossSiteFrameChain(t *testing.T) {
	h := upgradeHandler()
	step := func(target, from, mode, dest string) string {
		r := httptest.NewRequest("GET", "/x", nil)
		r.Header.Set("Sec-Fetch-Mode", mode)
		r.Header.Set("Sec-Fetch-Dest", dest)
		if from != "" {
			r.Header.Set(InitiatorHeader, from)
		}
		u, _ := url.Parse(target)
		h.storageAccess(r, u, "sa")
		return r.Header.Get("Sec-Fetch-Storage-Access")
	}
	for _, c := range []struct{ target, from, mode, dest, want string }{
		{"https://a.example/", "", "navigate", "document", ""},
		{"https://a.example/i", "https://a.example/", "no-cors", "image", ""},
		{"https://b.example/f", "https://a.example/", "navigate", "iframe", "active"},
		{"https://a.example/x", "https://b.example/f", "no-cors", "image", "active"},
		{"https://a.example/aba", "https://b.example/f", "navigate", "iframe", "active"},
		{"https://a.example/y", "https://a.example/aba", "no-cors", "image", "active"},
		{"http://u.example/z", "https://b.example/f", "no-cors", "image", ""}, // not trustworthy
	} {
		if got := step(c.target, c.from, c.mode, c.dest); got != c.want {
			t.Errorf("%s from %s (%s %s): %q, want %q", c.target, c.from, c.mode, c.dest, got, c.want)
		}
	}
}
