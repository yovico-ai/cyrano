package proxy

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestSpecConformance_StylesheetNosniff(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		same := rapid.Bool().Draw(rt, "same")
		ns := rapid.Bool().Draw(rt, "nosniff")
		ct := rapid.SampledFrom([]string{"-", "", "text/css", "TEXT/CSS", "text/css; charset=utf-8", " text/css\t", "text/plain", "application/octet-stream", "foo", ";", "text/css2", "*/*"}).Draw(rt, "ct")
		b := func(x bool) string {
			if x {
				return "1"
			}
			return "0"
		}
		want, _, err := oracle.Ask("sheetnosniff", b(same), ct, b(ns))
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		var cts []string
		if ct != "-" {
			cts = []string{ct}
		}
		if got := stylesheetNosniff(same, cts, ns); got != (want == "yes") {
			rt.Fatalf("stylesheetNosniff(%v, %q, %v) = %v, spec %s", same, ct, ns, got, want)
		}
	})
}

// A cross-origin sheet served as text/plain applied in a quirks document
// through the proxy, where directly it does not.
func TestAddStylesheetNosniff(t *testing.T) {
	mk := func(page, sheet, ct, dest string) *http.Response {
		u, _ := url.Parse(sheet)
		req := &http.Request{URL: u, Header: http.Header{"Sec-Fetch-Dest": {dest}}}
		req = req.WithContext(context.WithValue(context.Background(), requesterKey{}, page))
		return &http.Response{Request: req, Header: http.Header{"Content-Type": {ct}}}
	}
	for _, c := range []struct {
		page, sheet, ct, dest string
		want             bool
	}{
		{"https://a.example/p", "https://cdn.example/s.css", "text/plain", "style", true},
		{"https://a.example/p", "https://a.example/s.css", "text/plain", "style", false},
		{"https://a.example/p", "https://cdn.example/s.css", "text/css", "style", false},
		{"https://a.example/p", "https://cdn.example/s.css", "text/plain", "script", false},
		{"https://a.example/p", "http://a.example/s.css", "text/plain", "style", true},
	} {
		resp := mk(c.page, c.sheet, c.ct, c.dest)
		addStylesheetNosniff(resp)
		if got := strings.EqualFold(resp.Header.Get("X-Content-Type-Options"), "nosniff"); got != c.want {
			t.Errorf("%+v: nosniff %v", c, got)
		}
	}
}
