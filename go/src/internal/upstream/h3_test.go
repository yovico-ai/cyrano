package upstream

// HTTP/3 as Chrome chooses it (h3.go, spec/Alpn.agda), against local
// servers: the connection is raced, never the request.

import (
	"github.com/bogdanfinn/tls-client/profiles"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	"github.com/bogdanfinn/quic-go-utls/http3"
	utls "github.com/bogdanfinn/utls"
)

const ua139 = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"

type counts struct {
	mu sync.Mutex
	n  map[string]int // "proto method body"
}

func (c *counts) add(k string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.n[k]++
}

func (c *counts) get(k string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n[k]
}

// tlsServer is an HTTP/2 server offering h3 on its own port.
func tlsServer(t *testing.T, c *counts) (*httptest.Server, int) {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		c.add("tcp " + r.Method + " " + string(b))
		_, port, _ := net.SplitHostPort(r.Host)
		w.Header().Set("Alt-Svc", `h3=":`+port+`"; ma=60`)
		io.WriteString(w, "tcp")
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	_, p, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(p)
	return srv, port
}

func send(t *testing.T, rt *RoundTripper, method, url, body string) *http.Response {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, url, r)
	req.RequestURI = ""
	req.Header.Set("User-Agent", ua139)
	resp, err := rt.RoundTrip(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp
}

// Alt-Svc offers h3 on a port where no QUIC server answers: the next
// request — a POST — goes over TCP once, never twice, and the origin is
// marked broken (later requests do not wait for QUIC again).
func TestH3_FallbackSendsOnce(t *testing.T) {
	c := &counts{n: map[string]int{}}
	srv, port := tlsServer(t, c)
	rt := NewRoundTripper(true)
	if r := send(t, rt, "GET", srv.URL+"/a", ""); r.ProtoMajor != 2 {
		t.Fatalf("first request over %s, want HTTP/2", r.Proto)
	}
	if !rt.h3.want(t.Context(), "", "https", "127.0.0.1", port) {
		t.Fatalf("Alt-Svc h3 offer not taken")
	}
	t1 := time.Now()
	r := send(t, rt, "POST", srv.URL+"/p", "once")
	if d := time.Since(t1); d > quicRace+500*time.Millisecond {
		t.Fatalf("the POST waited %v for QUIC (race %v)", d, quicRace)
	}
	if r.ProtoMajor != 2 {
		t.Fatalf("POST over %s, want the TCP fallback", r.Proto)
	}
	if n := c.get("tcp POST once"); n != 1 {
		t.Fatalf("POST reached the origin %d times, want 1", n)
	}
	// The request did not wait for the handshake; the dial goes on and,
	// failing, marks the origin broken.
	for end := time.Now().Add(quicHandshakeTimeout + time.Second); rt.h3.want(t.Context(), "", "https", "127.0.0.1", port); {
		if time.Now().After(end) {
			t.Fatalf("origin not marked broken after a failed QUIC connection")
		}
		time.Sleep(50 * time.Millisecond)
	}
	t0 := time.Now()
	send(t, rt, "GET", srv.URL+"/b", "")
	if d := time.Since(t0); d > time.Second {
		t.Fatalf("a broken origin still waited %v for QUIC", d)
	}
}

// With an HTTP/3 server on the offered port, requests after the offer go
// over HTTP/3, once each; another session has not seen the offer.
func TestH3_AltSvcThenH3(t *testing.T) {
	c := &counts{n: map[string]int{}}
	srv, port := tlsServer(t, c)
	cert := srv.TLS.Certificates[0]
	udp, err := net.ListenPacket("udp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		t.Skipf("udp port %d: %v", port, err)
	}
	h3s := &http3.Server{
		TLSConfig: http3.ConfigureTLSConfig(&utls.Config{Certificates: []utls.Certificate{{Certificate: cert.Certificate, PrivateKey: cert.PrivateKey}}}),
		Handler: fhttp.HandlerFunc(func(w fhttp.ResponseWriter, r *fhttp.Request) {
			b, _ := io.ReadAll(r.Body)
			c.add("quic " + r.Method + " " + string(b))
			io.WriteString(w, "quic")
		}),
	}
	go h3s.Serve(udp)
	t.Cleanup(func() { h3s.Close(); udp.Close() })

	rt := NewRoundTripper(true)
	send(t, rt, "GET", srv.URL+"/a", "")
	r := send(t, rt, "POST", srv.URL+"/p", "body")
	if r.ProtoMajor != 3 {
		t.Fatalf("after the Alt-Svc offer: %s, want HTTP/3", r.Proto)
	}
	if c.get("quic POST body") != 1 || c.get("tcp POST body") != 0 {
		t.Fatalf("POST: quic %d, tcp %d; want 1, 0", c.get("quic POST body"), c.get("tcp POST body"))
	}
	if rt.h3.want(t.Context(), "other-session", "https", "127.0.0.1", port) {
		t.Fatalf("one session's Alt-Svc steered another")
	}
}

// Alt-Svc: clear forgets the offer.
func TestH3_AltSvcClear(t *testing.T) {
	s := newH3State()
	s.noteAltSvc("s", "a.example", 443, []string{`h3=":443"`})
	if !s.want(t.Context(), "s", "https", "a.example", 443) {
		t.Fatal("offer not taken")
	}
	s.noteAltSvc("s", "a.example", 443, []string{"clear"})
	o := s.origins[originKey("s", "a.example", 443)]
	if len(o.liveOffers(time.Now())) != 0 {
		t.Fatal("clear kept the offer")
	}
}

// The QPACK decoder has no dynamic table, so the SETTINGS give it none:
// Chrome's profile offers 64 KiB, Google and Cloudflare front ends then
// encode against it and every such response failed ("qpack: expected
// Required Insert Count to be zero": ingest.quantummetric.com,
// fonts.gstatic.com, googletagmanager.com — geico.app.link's canvaskit).
func TestH3SettingsNoDynamicTable(t *testing.T) {
	tr := newH3Transport(profiles.Chrome_144, nil, false)
	if got, ok := tr.t.AdditionalSettings[qpackMaxTableCapacity]; !ok || got != 0 {
		t.Errorf("QPACK_MAX_TABLE_CAPACITY = %d (sent %v), want 0", got, ok)
	}
	if got := tr.t.AdditionalSettings[qpackBlockedStreams]; got != 0 {
		t.Errorf("QPACK_BLOCKED_STREAMS = %d, want 0", got)
	}
	// Chrome's other settings and its order kept.
	if len(tr.t.AdditionalSettingsOrder) != len(profiles.Chrome_144.GetHttp3SettingsOrder()) {
		t.Errorf("settings order %v, want Chrome's %v", tr.t.AdditionalSettingsOrder, profiles.Chrome_144.GetHttp3SettingsOrder())
	}
}

// The HTTP/3 connection fails under a request, before its response: the
// server closes it with an error (Cloudflare's PROTOCOL_VIOLATION on
// misting.party; a pooled connection idled out, a stateless reset). A
// request none of whose body was sent goes again over TCP, once, as
// Chrome resends it without the alternative (spec/Alpn.agda); it used to
// reach the page as a failed load. A POST whose body went over the lost
// connection is not sent twice. The origin is not marked broken (the
// connection was made): the next request is over HTTP/3 again.
func TestH3_ConnectionLostRetriesOverTCP(t *testing.T) {
	c := &counts{n: map[string]int{}}
	srv, port := tlsServer(t, c)
	cert := srv.TLS.Certificates[0]
	udp, err := net.ListenPacket("udp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		t.Skipf("udp port %d: %v", port, err)
	}
	h3s := &http3.Server{
		TLSConfig: http3.ConfigureTLSConfig(&utls.Config{Certificates: []utls.Certificate{{Certificate: cert.Certificate, PrivateKey: cert.PrivateKey}}}),
		Handler: fhttp.HandlerFunc(func(w fhttp.ResponseWriter, r *fhttp.Request) {
			b, _ := io.ReadAll(r.Body)
			c.add("quic " + r.Method + " " + r.URL.Path + " " + string(b))
			if strings.HasPrefix(r.URL.Path, "/lost") {
				w.(http3.Hijacker).Connection().CloseWithError(0x101, "protocol violation")
				return
			}
			io.WriteString(w, "quic")
		}),
	}
	go h3s.Serve(udp)
	t.Cleanup(func() { h3s.Close(); udp.Close() })

	rt := NewRoundTripper(true)
	send(t, rt, "GET", srv.URL+"/a", "") // the Alt-Svc offer
	if r := send(t, rt, "GET", srv.URL+"/b", ""); r.ProtoMajor != 3 {
		t.Fatalf("after the offer: %s, want HTTP/3", r.Proto)
	}
	tcpBefore := c.get("tcp GET ")
	r := send(t, rt, "GET", srv.URL+"/lost", "")
	if r.ProtoMajor != 2 {
		t.Fatalf("a GET whose connection was lost: %s, want the TCP resend", r.Proto)
	}
	if q, tc := c.get("quic GET /lost "), c.get("tcp GET ")-tcpBefore; q != 1 || tc != 1 {
		t.Fatalf("GET /lost: quic %d, tcp %d; want 1, 1", q, tc)
	}
	// A POST whose body went over the lost connection fails, sent once.
	req := httptest.NewRequest("POST", srv.URL+"/lost-post", strings.NewReader("once"))
	req.RequestURI = ""
	req.Header.Set("User-Agent", ua139)
	if resp, err := rt.RoundTrip(req); err == nil {
		resp.Body.Close()
		if c.get("tcp POST once") != 0 {
			t.Fatalf("the POST was sent again over TCP")
		}
	}
	if n := c.get("quic POST /lost-post once") + c.get("tcp POST once"); n != 1 {
		t.Fatalf("POST reached the origin %d times, want 1", n)
	}
	// Not broken: HTTP/3 again for the next request.
	if !rt.h3.want(t.Context(), "", "https", "127.0.0.1", port) {
		t.Fatalf("a lost connection marked the origin broken")
	}
	var proto int
	for end := time.Now().Add(3 * time.Second); time.Now().Before(end); time.Sleep(50 * time.Millisecond) {
		if proto = send(t, rt, "GET", srv.URL+"/c", "").ProtoMajor; proto == 3 {
			break
		}
	}
	if proto != 3 {
		t.Fatalf("after a lost connection: HTTP/%d, want HTTP/3 again", proto)
	}
}
