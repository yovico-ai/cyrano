package headerorder

// Conformance of the recorder's HTTP/1.1 framing with spec/H1.agda: the
// records of pipelined requests fed in random pieces are the spec's; and
// net/http's server, reading the same browser-like stream, serves each
// request with the spec's record.

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestMain(m *testing.M) { specoracle.Main(m, []string{"http", "https", "ws", "wss"}) }

var headerNames = []string{"Host", "User-Agent", "accept", "Accept-Language", "Content-Type", "X-Custom", "sec-ch-ua", "Sec-Fetch-Mode", "Cookie", "Priority", "Origin", "Referer"}

// request writes one request; odd: framing a browser never sends (fed to
// the recorder only).
func request(rt *rapid.T, odd bool) string {
	var b strings.Builder
	method := rapid.SampledFrom([]string{"GET", "POST", "PUT"}).Draw(rt, "method")
	fmt.Fprintf(&b, "%s /p%d HTTP/1.1\r\n", method, rapid.IntRange(0, 99).Draw(rt, "path"))
	names := rapid.SliceOfNDistinct(rapid.SampledFrom(headerNames), 0, 6, func(s string) string { return strings.ToLower(s) }).Draw(rt, "names")
	if !odd {
		names = append([]string{"Host"}, filterOut(names, "Host")...)
	}
	ws := func(l string) string {
		if odd {
			return rapid.SampledFrom([]string{"", " ", "\t", "  "}).Draw(rt, l)
		}
		return ""
	}
	for _, n := range names {
		v := rapid.SampledFrom([]string{"v", "a b", "x:y", "1"}).Draw(rt, "value")
		if strings.EqualFold(n, "host") {
			v = "h.example" // net/http refuses an invalid one
		}
		fmt.Fprintf(&b, "%s%s:%s%s%s\r\n", n, ws("nws"), rapid.SampledFrom([]string{" ", "", "\t"}).Draw(rt, "vws"), v, ws("tws"))
	}
	body := rapid.SampledFrom([]string{"none", "length", "chunked"}).Draw(rt, "body")
	payload := rapid.SampledFrom([]string{"", "x", "a\r\n\r\nb", "GET / HTTP/1.1\r\n\r\n", strings.Repeat("z", 300)}).Draw(rt, "payload")
	switch body {
	case "length":
		cl := fmt.Sprint(len(payload))
		if odd {
			cl = rapid.SampledFrom([]string{cl, " " + cl + " ", "+" + cl, cl + "x", "0" + cl}).Draw(rt, "cl")
		}
		fmt.Fprintf(&b, "Content-Length: %s\r\n\r\n%s", cl, payload)
	case "chunked":
		te := "chunked"
		if odd {
			te = rapid.SampledFrom([]string{"chunked", "Chunked", "gzip, chunked", "CHUNKED "}).Draw(rt, "te")
		}
		fmt.Fprintf(&b, "Transfer-Encoding: %s\r\n\r\n", te)
		for _, part := range rapid.SliceOfN(rapid.SampledFrom([]string{"x", "a\r\n\r\nb", "0\r\n\r\n", strings.Repeat("q", 20)}), 0, 3).Draw(rt, "chunks") {
			size := fmt.Sprintf("%x", len(part))
			if odd {
				size = rapid.SampledFrom([]string{size, strings.ToUpper(size), " " + size, size + ";ext=1", size + " ;e", "+" + size, "0x" + size}).Draw(rt, "size")
			} else if rapid.Bool().Draw(rt, "ext") {
				size += ";ext=1"
			}
			fmt.Fprintf(&b, "%s\r\n%s\r\n", size, part)
		}
		b.WriteString("0\r\n")
		if rapid.Bool().Draw(rt, "trailer") {
			b.WriteString("X-Trailer: t\r\n")
		}
		b.WriteString("\r\n")
	default:
		if odd && rapid.IntRange(0, 9).Draw(rt, "upgrade") == 0 {
			b.WriteString("Upgrade: websocket\r\n")
		}
		b.WriteString("\r\n")
	}
	return b.String()
}

func filterOut(xs []string, x string) []string {
	var out []string
	for _, y := range xs {
		if !strings.EqualFold(y, x) {
			out = append(out, y)
		}
	}
	return out
}

func stream(rt *rapid.T, odd bool) string {
	var b strings.Builder
	for i, n := 0, rapid.IntRange(1, 5).Draw(rt, "requests"); i < n; i++ {
		b.WriteString(request(rt, odd))
	}
	if odd && rapid.Bool().Draw(rt, "cut") { // a last request not all here
		s := b.String()
		return s[:rapid.IntRange(0, len(s)).Draw(rt, "at")]
	}
	return b.String()
}

func show(orders [][]string) string {
	var b strings.Builder
	for _, o := range orders {
		b.WriteString("<" + strings.Join(o, ",") + ">")
	}
	return b.String()
}

// pieces splits s at random points.
func pieces(rt *rapid.T, s string) []string {
	var out []string
	for len(s) > 0 {
		n := rapid.IntRange(1, len(s)).Draw(rt, "piece")
		out, s = append(out, s[:n]), s[n:]
	}
	return out
}

func TestSpecConformance_HeaderOrderFraming(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		s := stream(rt, true)
		want, _, err := oracle.Ask("h1orders", s)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		c := &conn{}
		for _, p := range pieces(rt, s) {
			c.feed([]byte(p))
		}
		if got := show(c.orders); got != want {
			rt.Fatalf("stream %q\n got  %s\n spec %s", s, got, want)
		}
	})
}

// net/http reads the same stream as the recorder does: every request the
// server serves carries the spec's record for it.
func TestSpecConformance_HeaderOrderServed(t *testing.T) {
	oracle := specoracle.Need(t)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	got := make(chan []string, 16)
	srv := &http.Server{ConnContext: ConnContext, Handler: Handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		got <- FromContext(r.Context())
		fmt.Fprint(w, "ok")
	}))}
	go func() { _ = srv.Serve(Listener(l)) }()
	defer srv.Close()
	rapid.Check(t, func(rt *rapid.T) {
		s := stream(rt, false)
		want, _, err := oracle.Ask("h1orders", s)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		c, err := net.Dial("tcp", l.Addr().String())
		if err != nil {
			rt.Fatal(err)
		}
		defer c.Close()
		ps := pieces(rt, s)
		go func() {
			for _, p := range ps {
				_, _ = c.Write([]byte(p))
			}
		}()
		br := bufio.NewReader(c)
		var orders [][]string
		for range strings.Count(want, "<") {
			resp, err := http.ReadResponse(br, nil)
			if err != nil {
				rt.Fatalf("stream %q: %v", s, err)
			}
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			select {
			case o := <-got:
				orders = append(orders, o)
			case <-time.After(5 * time.Second):
				rt.Fatalf("stream %q: no request served", s)
			}
		}
		if show(orders) != want {
			rt.Fatalf("stream %q\n served %s\n spec   %s", s, show(orders), want)
		}
	})
}
