package upstream

import (
	"bufio"
	"net"
	"time"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
)

// The origin answers a request on a kept-alive connection and then closes
// it without a word; the next request, sent on that connection, finds it
// gone before any response. Chrome sends it again on a fresh connection;
// the page sees its response, never the loss.
func TestReusedConnectionLostIsResent(t *testing.T) {
	var n atomic.Int32
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if n.Add(1) == 1 {
			// Answer, saying the connection stays, then close it.
			conn, buf, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Errorf("hijack: %v", err)
				return
			}
			io.WriteString(buf, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok")
			buf.Flush()
			conn.Close()
			return
		}
		io.WriteString(w, "again")
	}))
	srv.StartTLS() // HTTP/1.1 only
	defer srv.Close()
	rt := NewRoundTripper(true)
	for i, want := range []string{"ok", "again"} {
		resp, err := rt.RoundTrip(newReq(t, "GET", srv.URL+"/x"))
		if err != nil {
			t.Fatalf("request %d: %v (a request lost on a reused connection reached the page)", i, err)
		}
		b, _ := io.ReadAll(bufio.NewReader(resp.Body))
		resp.Body.Close()
		if string(b) != want {
			t.Fatalf("request %d: %q, want %q", i, b, want)
		}
	}
}

// The same over HTTP/2: the origin drops the connection (no GOAWAY) once
// it is idle after the first response.
func TestReusedHTTP2ConnectionLostIsResent(t *testing.T) {
	var n atomic.Int32
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if n.Add(1) == 1 {
			io.WriteString(w, "ok")
			return
		}
		io.WriteString(w, "again")
	}))
	var conns []net.Conn
	var mu sync.Mutex
	srv.Config.ConnState = func(c net.Conn, s http.ConnState) {
		if s == http.StateNew {
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
		}
	}
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()
	rt := NewRoundTripper(true)
	for i, want := range []string{"ok", "again"} {
		resp, err := rt.RoundTrip(newReq(t, "GET", srv.URL+"/x"))
		if err != nil {
			t.Fatalf("request %d: %v (a request lost on a reused connection reached the page)", i, err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if string(b) != want {
			t.Fatalf("request %d over %s: %q, want %q", i, resp.Proto, b, want)
		}
		if i == 0 {
			// The origin drops the connection, without a word.
			mu.Lock()
			for _, c := range conns {
				c.Close()
			}
			mu.Unlock()
			time.Sleep(20 * time.Millisecond)
		}
	}
}

// The origin closes the reused connection as the request arrives — no
// response at all (its idle timeout racing the request: newsweek.com's
// "Get …: EOF"). Chrome sends it again, once, on a fresh connection.
func TestReusedConnectionClosedAtTheRequestIsResent(t *testing.T) {
	var n atomic.Int32
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch n.Add(1) {
		case 1:
			io.WriteString(w, "ok")
		case 2:
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				conn.Close() // nothing answered
			}
		default:
			io.WriteString(w, "again")
		}
	}))
	srv.StartTLS() // HTTP/1.1
	defer srv.Close()
	rt := NewRoundTripper(true)
	for i, want := range []string{"ok", "again"} {
		resp, err := rt.RoundTrip(newReq(t, "GET", srv.URL+"/x"))
		if err != nil {
			t.Fatalf("request %d: %v (a request lost on a reused connection reached the page)", i, err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if string(b) != want {
			t.Fatalf("request %d: %q, want %q", i, b, want)
		}
	}
	if got := n.Load(); got != 3 {
		t.Fatalf("the origin got %d requests, want 3 (the lost one sent again once)", got)
	}
}

// The same race over HTTP/2: the connection is dropped as the second
// request arrives, nothing answered.
func TestReusedHTTP2ConnectionClosedAtTheRequestIsResent(t *testing.T) {
	var n atomic.Int32
	var conns []net.Conn
	var mu sync.Mutex
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch n.Add(1) {
		case 1:
			io.WriteString(w, "ok")
		case 2:
			mu.Lock()
			for _, c := range conns {
				c.Close()
			}
			mu.Unlock()
		default:
			io.WriteString(w, "again")
		}
	}))
	srv.Config.ConnState = func(c net.Conn, s http.ConnState) {
		if s == http.StateNew {
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
		}
	}
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()
	rt := NewRoundTripper(true)
	for i, want := range []string{"ok", "again"} {
		resp, err := rt.RoundTrip(newReq(t, "GET", srv.URL+"/x"))
		if err != nil {
			t.Fatalf("request %d: %v (a request lost on a reused connection reached the page)", i, err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if string(b) != want {
			t.Fatalf("request %d over %s: %q, want %q", i, resp.Proto, b, want)
		}
	}
}
