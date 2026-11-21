package upstream

import (
	"bufio"
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

// h1Head is spec/H1.agda h1Head.
func TestSpecConformance_H1Head(t *testing.T) {
	oracle := specoracle.Need(t)
	pool := []string{"user-agent", "Accept", "sec-ch-ua", "Sec-Ch-Ua-Platform", "sec-ch-ua-full-version-list", "Priority", "priority", "Host", "connection",
		"Sec-Fetch-Mode", "accept-language", "Cookie", "X-Custom-Thing", "x-requested-with", "Referer", "Upgrade-Insecure-Requests", "dnt", "content-type"}
	rapid.Check(t, func(rt *rapid.T) {
		names := rapid.SliceOfN(rapid.SampledFrom(pool), 0, 10).Draw(rt, "names")
		want, _, err := oracle.Ask("h1head", strings.Join(names, "\n"))
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := strings.Join(h1Head(names), "\n"); got != want {
			rt.Fatalf("h1Head(%q)\n got  %q\n spec %q", names, got, want)
		}
	})
}

// headServer accepts HTTP/1.1 (over TLS offering only http/1.1, or plain)
// and hands back each request's head as it arrived on the wire.
func headServer(t *testing.T, useTLS bool) (string, chan string) {
	t.Helper()
	var ln net.Listener
	var err error
	if useTLS {
		srv := httptest.NewUnstartedServer(nil)
		srv.StartTLS()
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
	ch := make(chan string, 4)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				br := bufio.NewReader(c)
				var b strings.Builder
				for {
					l, err := br.ReadString('\n')
					if err != nil {
						return
					}
					if l == "\r\n" {
						break
					}
					b.WriteString(l)
				}
				ch <- b.String()
				io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
			}(c)
		}
	}()
	scheme := "http"
	if useTLS {
		scheme = "https"
	}
	return scheme + "://" + ln.Addr().String(), ch
}

// Over HTTP/1.1 the upstream writes Chrome's head: what Chrome 139 wrote
// to an HTTP/1.1-only server, header for header (the request's headers in
// Chrome's HTTP/2 order, as the proxy has them).
func TestHTTP1HeadIsChromes(t *testing.T) {
	rt := NewRoundTripper(true)
	for _, useTLS := range []bool{true, false} {
		base, heads := headServer(t, useTLS)
		req, _ := http.NewRequest("GET", base+"/x", nil)
		for _, kv := range [][2]string{
			{"sec-ch-ua", `"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"`},
			{"sec-ch-ua-mobile", "?0"}, {"sec-ch-ua-platform", `"Linux"`}, {"upgrade-insecure-requests", "1"},
			{"user-agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"},
			{"accept", "text/html"}, {"sec-fetch-site", "none"}, {"sec-fetch-mode", "navigate"}, {"sec-fetch-user", "?1"},
			{"sec-fetch-dest", "document"}, {"accept-encoding", "gzip, deflate, br, zstd"}, {"accept-language", "en-US,en;q=0.9"}, {"priority", "u=0, i"},
		} {
			req.Header.Set(kv[0], kv[1])
		}
		resp, err := rt.RoundTrip(req)
		if err != nil {
			t.Fatalf("tls=%v: %v", useTLS, err)
		}
		resp.Body.Close()
		var head string
		select {
		case head = <-heads:
		case <-time.After(5 * time.Second):
			t.Fatalf("tls=%v: no request arrived", useTLS)
		}
		var names []string
		for _, l := range strings.Split(strings.TrimRight(head, "\r\n"), "\r\n")[1:] {
			names = append(names, l[:strings.IndexByte(l, ':')])
		}
		want := "Host Connection sec-ch-ua sec-ch-ua-mobile sec-ch-ua-platform Upgrade-Insecure-Requests User-Agent Accept Sec-Fetch-Site Sec-Fetch-Mode Sec-Fetch-User Sec-Fetch-Dest Accept-Encoding Accept-Language"
		if got := strings.Join(names, " "); got != want {
			t.Errorf("tls=%v: head names\n got  %s\n want %s", useTLS, got, want)
		}
		if !strings.Contains(head, "\r\nConnection: keep-alive\r\n") {
			t.Errorf("tls=%v: no Connection: keep-alive in\n%s", useTLS, head)
		}
	}
}

// Over HTTP/2 the head is left as it was: Priority stays, no Connection.
func TestHTTP2HeadUnchanged(t *testing.T) {
	seen := make(chan http.Header, 1)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { seen <- r.Header.Clone() }))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()
	req, _ := http.NewRequest("GET", srv.URL+"/x", nil)
	req.Header.Set("priority", "u=0, i")
	req.Header.Set("sec-ch-ua-mobile", "?0")
	resp, err := NewRoundTripper(true).RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.ProtoMajor != 2 {
		t.Fatalf("spoke %s", resp.Proto)
	}
	h := <-seen
	if h.Get("Priority") != "u=0, i" || h.Get("Connection") != "" {
		t.Errorf("over HTTP/2: Priority %q, Connection %q", h.Get("Priority"), h.Get("Connection"))
	}
}

// http: and https: to one host and port keep apart: the client caches a
// transport per host and port (an http: URL without a port counts as
// 443), so an http: request after an https: one met the HTTP/2 transport
// and failed "http2: unsupported scheme" (ad user-syncs to http: pixels).
func TestHTTPAfterHTTPSSameHostPort(t *testing.T) {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()
	rt := NewRoundTripper(true)
	ctx := context.WithValue(context.Background(), SessionKey{}, "s1")
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/x", nil)
	resp, err := rt.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	plain, _ := http.NewRequestWithContext(ctx, "GET", strings.Replace(srv.URL, "https://", "http://", 1)+"/y", nil)
	resp, err = rt.RoundTrip(plain)
	if err != nil && strings.Contains(err.Error(), "unsupported scheme") {
		t.Fatalf("http: went to the https: transport: %v", err)
	}
	if resp != nil {
		resp.Body.Close() // the TLS server answers 400 to plain HTTP: what matters is that it was HTTP/1.1
	}
}
