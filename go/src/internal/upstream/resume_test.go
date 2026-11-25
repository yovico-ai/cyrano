package upstream

import (
	"context"
	"crypto/tls"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// TestSessionResumption: a second connection to a host resumes the TLS
// session as Chrome's does — its hello offers the ticket (pre_shared_key,
// the last extension) where the first had no such extension — and another
// session's connection does not (tickets are the session's own), nor do
// session-less requests, which are every unauthenticated user's.
// Before resume.go every connection was a full handshake.
func TestSessionResumption(t *testing.T) {
	var mu sync.Mutex
	var hellos [][]uint16
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS.DidResume {
			io.WriteString(w, "resumed")
		} else {
			io.WriteString(w, "full")
		}
	}))
	srv.EnableHTTP2 = true
	srv.TLS = &tls.Config{MinVersion: tls.VersionTLS13, GetConfigForClient: func(h *tls.ClientHelloInfo) (*tls.Config, error) {
		mu.Lock()
		hellos = append(hellos, append([]uint16(nil), h.Extensions...))
		mu.Unlock()
		return nil, nil
	}}
	srv.StartTLS()
	defer srv.Close()

	rt := NewRoundTripper(true)
	get := func(session string) string {
		req := newReq(t, "GET", srv.URL)
		req = req.WithContext(context.WithValue(req.Context(), SessionKey{}, session))
		resp, err := rt.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		rt.mu.Lock()
		for _, e := range rt.clients {
			e.client.CloseIdleConnections() // the next request dials again
		}
		rt.mu.Unlock()
		return string(b)
	}
	got := []string{get("s1"), get("s1"), get("s2"), get(""), get("")}
	if want := []string{"full", "resumed", "full", "full", "full"}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] || got[3] != want[3] || got[4] != want[4] {
		t.Fatalf("handshakes: got %v, want %v", got, want)
	}
	const psk = 41
	has := func(h []uint16) bool {
		for _, e := range h {
			if e == psk {
				return true
			}
		}
		return false
	}
	mu.Lock()
	defer mu.Unlock()
	if len(hellos) != 5 {
		t.Fatalf("hellos: %d", len(hellos))
	}
	if has(hellos[0]) || has(hellos[2]) || has(hellos[3]) || has(hellos[4]) {
		t.Error("a hello with no ticket to offer carries pre_shared_key")
	}
	if h := hellos[1]; !has(h) || h[len(h)-1] != psk {
		t.Errorf("resuming hello: pre_shared_key not last: %v", h)
	}
}
