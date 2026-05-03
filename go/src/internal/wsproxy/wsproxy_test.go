package wsproxy

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestIsWSUpgrade(t *testing.T) {
	cases := []struct {
		name     string
		upgrade  string
		conn     string
		expected bool
	}{
		{"both set", "websocket", "Upgrade", true},
		{"both set lowercase", "websocket", "upgrade", true},
		{"connection comma list", "websocket", "keep-alive, Upgrade", true},
		{"missing upgrade", "", "Upgrade", false},
		{"wrong upgrade", "h2c", "Upgrade", false},
		{"missing connection", "websocket", "", false},
		{"connection without upgrade", "websocket", "keep-alive", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/", nil)
			if c.upgrade != "" {
				r.Header.Set("Upgrade", c.upgrade)
			}
			if c.conn != "" {
				r.Header.Set("Connection", c.conn)
			}
			got := IsWSUpgrade(r)
			if got != c.expected {
				t.Errorf("got %v want %v", got, c.expected)
			}
		})
	}
}

func TestServeHTTP_RejectsBadLoadParam(t *testing.T) {
	h := New(Options{})
	for _, path := range []string{
		"/cyrano/",              // no scheme
		"/cyrano/ftp/x/",        // unsupported scheme
		"/cyrano/http/",         // no host
	} {
		req := httptest.NewRequest("GET", path, nil)
		req.Header.Set("Upgrade", "websocket")
		req.Header.Set("Connection", "Upgrade")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code < 400 || rec.Code >= 500 {
			t.Errorf("path=%q: status %d, want 4xx", path, rec.Code)
		}
	}
}

// Stub upstream that accepts a WebSocket-style upgrade and echoes one
// message back. Doesn't implement the full protocol — just enough to
// verify our handler can complete the handshake and pipe bytes.
func startWSUpstream(t *testing.T) (string, func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		// Read the request line + headers
		br := bufio.NewReader(c)
		for {
			line, err := br.ReadString('\n')
			if err != nil || strings.TrimSpace(line) == "" {
				break
			}
		}
		// Reply 101 Switching Protocols
		_, _ = c.Write([]byte("HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			"Sec-WebSocket-Accept: stub\r\n" +
			"\r\n"))
		// Echo whatever we get next
		buf := make([]byte, 4096)
		c.SetReadDeadline(time.Now().Add(3 * time.Second))
		n, _ := c.Read(buf)
		if n > 0 {
			_, _ = c.Write(buf[:n])
		}
	}()
	return ln.Addr().String(), func() { ln.Close() }
}

// End-to-end-ish: spin up a real http.Server in front of our wsproxy
// handler so http.Hijack works (httptest.NewRecorder doesn't support it),
// then drive it with a raw TCP client.
func TestUpgrade_FullCycle(t *testing.T) {
	upstreamAddr, stopUpstream := startWSUpstream(t)
	defer stopUpstream()

	h := New(Options{Logger: nil})
	srv := &http.Server{Handler: h}
	frontLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("front listen: %v", err)
	}
	defer frontLn.Close()
	go srv.Serve(frontLn)
	defer srv.Close()

	// Build the cyrano path for the upstream ws:// target.
	target := "ws://" + upstreamAddr + "/socket"
	u, _ := url.Parse(target)
	cyranoPath := "/cyrano/" + u.Scheme + "/" + u.Host + u.EscapedPath()

	// Open a raw client conn and send the upgrade request.
	c, err := net.Dial("tcp", frontLn.Addr().String())
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))

	upgrade := "GET " + cyranoPath + " HTTP/1.1\r\n" +
		"Host: localhost\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: dGVzdA==\r\n" +
		"Sec-WebSocket-Version: 13\r\n" +
		"\r\n"
	if _, err := c.Write([]byte(upgrade)); err != nil {
		t.Fatalf("write upgrade: %v", err)
	}

	// Read the upstream-relayed 101 response.
	br := bufio.NewReader(c)
	statusLine, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("read status: %v", err)
	}
	if !strings.Contains(statusLine, "101") {
		t.Fatalf("expected 101, got %q", statusLine)
	}
	// Drain the rest of the response headers
	for {
		line, err := br.ReadString('\n')
		if err != nil || strings.TrimSpace(line) == "" {
			break
		}
	}

	// Send a payload, expect it echoed by our stub upstream.
	payload := []byte("hello-ws")
	if _, err := c.Write(payload); err != nil {
		t.Fatalf("write payload: %v", err)
	}
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(br, got); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(got) != string(payload) {
		t.Errorf("echo mismatch: got %q want %q", got, payload)
	}
}
