package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The way a rewritten body goes out (known length, header then data in
// one write): net/http sniffs a type for it unless the writer stops it.
func TestTypelessWriter_StopsTheSniff(t *testing.T) {
	for _, wrap := range []bool{false, true} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var out http.ResponseWriter = w
			if wrap {
				out = typelessWriter{w}
			}
			out.Header().Set("Content-Length", "8")
			out.WriteHeader(200)
			_, _ = out.Write([]byte("ID3\x03\x00abc"))
		}))
		resp, err := http.Get(srv.URL)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		srv.Close()
		_, typed := resp.Header["Content-Type"]
		if typed != !wrap {
			t.Fatalf("wrapped %v: Content-Type %q", wrap, resp.Header.Get("Content-Type"))
		}
	}
}

// A response that came without Content-Type reaches the browser without
// one: net/http sniffed "audio/mpeg" for a typeless body beginning "ID3",
// and a script of it was refused, where directly it runs.
func TestProxy_TypelessResponseStaysTypeless(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header()["Content-Type"] = nil
		_, _ = w.Write([]byte("ID3\x03\x00 window.ran=1"))
	}))
	defer upstream.Close()
	front := httptest.NewServer(New(Options{}))
	defer front.Close()
	resp, err := http.Get(front.URL + cyranoPath(upstream.URL+"/s"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	_, _ = io.ReadAll(resp.Body)
	if v, ok := resp.Header["Content-Type"]; ok {
		t.Fatalf("Content-Type %q added to a typeless response", v)
	}
	// A typed one keeps its type.
	typed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ID3"))
	}))
	defer typed.Close()
	resp2, err := http.Get(front.URL + cyranoPath(typed.URL+"/s"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if got := resp2.Header.Get("Content-Type"); got != "text/plain" {
		t.Fatalf("Content-Type %q, want text/plain", got)
	}
}
