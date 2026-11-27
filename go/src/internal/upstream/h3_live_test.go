package upstream

import (
	"io"
	"net/http"
	"os"
	"testing"

	fhttp "github.com/bogdanfinn/fhttp"
	"github.com/bogdanfinn/tls-client/profiles"
)

// CYRANO_LIVE_H3=1: real requests over HTTP/3 (not in the default run).
func TestH3Transport_Live(t *testing.T) {
	if os.Getenv("CYRANO_LIVE_H3") == "" {
		t.Skip("CYRANO_LIVE_H3 unset")
	}
	tr := newH3Transport(profiles.Chrome_144, nil, false)
	for _, u := range []string{"https://codepen.io/trending", "https://www.findagrave.com/memorial/102647933/stephen_douglas-hacker"} {
		req, _ := fhttp.NewRequest("GET", u, nil)
		req.Header.Set("user-agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36")
		req.Header.Set("accept", "text/html")
		resp, err := tr.t.RoundTrip(req)
		if err != nil {
			t.Errorf("%s: %v", u, err)
			continue
		}
		n, err := io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		t.Logf("%s: %s %s, %d bytes, body err %v", u, resp.Status, resp.Proto, n, err)
	}
}

func TestH3RoundTripper_Live(t *testing.T) {
	if os.Getenv("CYRANO_LIVE_H3") == "" {
		t.Skip("CYRANO_LIVE_H3 unset")
	}
	rt := NewRoundTripper(false)
	for _, conn := range []string{"", "keep-alive"} {
		req, _ := http.NewRequest("GET", "https://codepen.io/trending", nil)
		req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36")
		req.Header.Set("Accept", "text/html")
		req.Header.Set("Sec-Fetch-Mode", "navigate")
		req.Header.Set("Priority", "u=0, i")
		if conn != "" {
			req.Header.Set("Connection", conn)
		}
		resp, err := rt.RoundTrip(req)
		if err != nil {
			t.Errorf("Connection %q: %v", conn, err)
			continue
		}
		n, _ := io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		t.Logf("Connection %q: %s %s %d bytes", conn, resp.Status, resp.Proto, n)
	}
}
