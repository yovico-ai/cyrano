package upstream

import (
	"net"
	"strings"

	fhttp "github.com/bogdanfinn/fhttp"
	utls "github.com/bogdanfinn/utls"
)

// A request's head as Chrome writes it over HTTP/1.1 (spec/H1.agda h1Head):
// Host first, then Connection: keep-alive, then the request's own headers
// in their order; client-hint names (sec-ch-…) in lower case, every other
// name with each word capitalized; no Priority, which Chrome sends on
// HTTP/2 and HTTP/3 only.
//
// Whether a request goes out over HTTP/1.1 is known only once its
// connection is up (ALPN), so the head is given this form then — in the
// client trace's GotConn, which both transports call after the handshake
// and before they write. Over HTTP/2 nothing changes. A Cloudflare site
// that negotiates HTTP/1.1 refused the proxy for Go's head — Host last, no
// Connection, Go's casing, a Priority header — where Chrome passed
// (spokanecounty.gov).

// h1Name is a header name as Chrome writes it on HTTP/1.1.
func h1Name(n string) string {
	l := strings.ToLower(n)
	if strings.HasPrefix(l, "sec-ch-") {
		return l
	}
	b := []byte(l)
	up := true
	for i, c := range b {
		if up && c >= 'a' && c <= 'z' {
			b[i] = c - 32
		}
		up = c == '-'
	}
	return string(b)
}

func placedByHead(n string) bool {
	switch strings.ToLower(n) {
	case "host", "connection", "priority":
		return true
	}
	return false
}

// h1Head is the names on the wire, in order, for a request whose headers
// are names (any case), in the order the proxy sends them.
func h1Head(names []string) []string {
	out := append(make([]string, 0, len(names)+2), "Host", "Connection")
	for _, n := range names {
		if !placedByHead(n) {
			out = append(out, h1Name(n))
		}
	}
	return out
}

// overHTTP1 reports whether a request on conn is sent as HTTP/1.x: a TLS
// connection that did not negotiate h2, or a connection without TLS.
func overHTTP1(conn net.Conn) bool {
	if conn == nil {
		return false
	}
	if c, ok := conn.(interface{ ConnectionState() utls.ConnectionState }); ok {
		return c.ConnectionState().NegotiatedProtocol != "h2"
	}
	return true
}

// asHTTP1 gives req's header map Chrome's HTTP/1.1 form, in place (the
// transport writes this map); host is the Host the request names. It may
// run more than once for a request (a retry on a new connection).
func asHTTP1(h fhttp.Header, host string) {
	order := h[fhttp.HeaderOrderKey]
	vals := map[string][]string{}
	for k, v := range h {
		if strings.Contains(k, ":") { // Header-Order:, PHeader-Order:
			continue
		}
		vals[strings.ToLower(k)] = v
		delete(h, k)
	}
	// Every header has its place: the given order, then any it leaves out.
	seen := map[string]bool{}
	names := make([]string, 0, len(vals))
	for _, n := range order {
		// Content-Length is added by the transport as it writes the head
		// (not in the map yet): its place in the order is kept.
		if l := strings.ToLower(n); (vals[l] != nil || l == "content-length") && !seen[l] {
			seen[l] = true
			names = append(names, l)
		}
	}
	for l := range vals {
		if !seen[l] {
			names = append(names, l)
		}
	}
	wire := h1Head(names)
	lower := make([]string, len(wire))
	for i, n := range wire {
		lower[i] = strings.ToLower(n)
		switch lower[i] {
		case "host":
			h[n] = []string{host}
		case "connection":
			h[n] = []string{"keep-alive"}
		default:
			if v := vals[lower[i]]; v != nil {
				h[n] = v
			}
		}
	}
	h[fhttp.HeaderOrderKey] = lower
}
