package upstream

import (
	"bufio"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// The upstream gets the request target byte for byte as the browser would
// send it directly — including what net/url would re-escape, and what Go's
// own HTTP server would reject ("/100%.jpg"; real origins serve it) — over
// the plain transport and the browser-impersonating https client.

// rawServer records each HTTP/1.1 request line as sent and answers 200.
// Go's http.Server cannot serve here: it rejects the very paths under test.
func rawServer(t *testing.T, useTLS bool) (base string, lines <-chan string) {
	t.Helper()
	var ln net.Listener
	var err error
	if useTLS {
		srv := httptest.NewUnstartedServer(http.NotFoundHandler())
		srv.StartTLS() // only to get a certificate
		cfg := srv.TLS.Clone()
		srv.Close()
		cfg.NextProtos = []string{"http/1.1"}
		ln, err = tls.Listen("tcp", "127.0.0.1:0", cfg)
	} else {
		ln, err = net.Listen("tcp", "127.0.0.1:0")
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	ch := make(chan string, 16)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				br := bufio.NewReader(c)
				for {
					line, err := br.ReadString('\n')
					if err != nil {
						return
					}
					for { // headers
						h, err := br.ReadString('\n')
						if err != nil || h == "\r\n" {
							break
						}
					}
					ch <- strings.TrimSpace(line)
					io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
				}
			}(c)
		}
	}()
	scheme := "http"
	if useTLS {
		scheme = "https"
	}
	return scheme + "://" + ln.Addr().String(), ch
}

func request(t *testing.T, base, path string) *http.Request {
	u, _ := url.Parse(base)
	u.Path, u.RawPath, u.ForceQuery = path, path, true
	if p, err := url.PathUnescape(path); err == nil {
		u.Path = p
	}
	req, _ := http.NewRequest("GET", base+"/", nil)
	req.URL = u
	return req
}

func TestExactRequestTargetOnTheWire_HTTP1(t *testing.T) {
	rt := NewRoundTripper(true)
	for _, useTLS := range []bool{false, true} {
		base, lines := rawServer(t, useTLS)
		for _, path := range []string{"/a%2Fb", "/x^|y", "/a%20b", "/100%.jpg", "/%zz"} {
			req := request(t, base, path)
			resp, err := rt.RoundTrip(req)
			if err != nil {
				t.Errorf("%s %q: %v", base, path, err)
				continue
			}
			resp.Body.Close()
			select {
			case got := <-lines:
				if want := "GET " + path + "? HTTP/1.1"; got != want {
					t.Errorf("%s: upstream saw %q, want %q", base, got, want)
				}
			case <-time.After(5 * time.Second):
				t.Errorf("%s %q: no request arrived", base, path)
			}
			if resp.Request != req {
				t.Errorf("%s %q: resp.Request is not the caller's request", base, path)
			}
		}
	}
}

func TestExactRequestTargetOnTheWire_HTTP2(t *testing.T) {
	seen := make(chan string, 1)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.RequestURI
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()
	rt := NewRoundTripper(true)
	// Go's h2 server rejects a :path with a stray '%' (PROTOCOL_ERROR), so
	// only well-formed escapes here; the h1 test covers the rest.
	for _, path := range []string{"/a%2Fb", "/x^|y", "/a%20b"} {
		resp, err := rt.RoundTrip(request(t, srv.URL, path))
		if err != nil {
			t.Errorf("%q: %v", path, err)
			continue
		}
		resp.Body.Close()
		if resp.ProtoMajor != 2 {
			t.Errorf("%q: spoke %s, want HTTP/2", path, resp.Proto)
		}
		if got := <-seen; got != path+"?" {
			t.Errorf("upstream saw %q, want %q", got, path+"?")
		}
	}
}
