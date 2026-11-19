package server

import (
	"net/http"
	"testing"
)

// A 304 (or 204, or a HEAD answer) with an HTML/CSS Content-Type and a
// Content-Encoding has no body to decompress: it must pass as it is, not
// fail (a 502 on every reload of such a CDN's pages).
func TestBodyAllowed(t *testing.T) {
	get := &http.Request{Method: http.MethodGet}
	head := &http.Request{Method: http.MethodHead}
	cases := []struct {
		req    *http.Request
		status int
		want   bool
	}{
		{get, 200, true}, {get, 404, true}, {get, 304, false}, {get, 204, false}, {get, 101, false}, {head, 200, false}, {nil, 200, true},
	}
	for _, c := range cases {
		if got := bodyAllowed(&http.Response{StatusCode: c.status, Request: c.req}); got != c.want {
			t.Errorf("bodyAllowed(%v %d) = %v, want %v", c.req, c.status, got, c.want)
		}
	}
}
