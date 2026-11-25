package proxy

import (
	"net/http"
	"testing"
)

// An HTTP/1.x origin's reason phrase rides Crn-H (spec/Carry.agda
// statusText); an HTTP/2 one has none, nor directly.
func TestCarryStatusText(t *testing.T) {
	for _, c := range []struct {
		proto  int
		status string
		want   string
	}{{1, "404 Nothing Here", `{":status-text":["Nothing Here"]}`}, {2, "404 Not Found", ""}, {1, "200", ""}} {
		resp := &http.Response{ProtoMajor: c.proto, Status: c.status, Header: http.Header{}}
		carryOriginalHeaders(resp.Header, resp.Header.Clone(), statusPhrase(resp))
		if got := resp.Header.Get(OriginalHeadersName); got != c.want {
			t.Errorf("HTTP/%d %q: Crn-H %q, want %q", c.proto, c.status, got, c.want)
		}
	}
}
