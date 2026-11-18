// Package headerorder recovers the order in which a browser sent its
// request headers.
//
// Header order is part of a browser's fingerprint: Chrome writes its
// headers in an order that depends on the kind of request and on where the
// page's own code added its headers — not alphabetically, and not from any
// fixed template. net/http keeps headers in a map and loses the order, so a
// proxy that re-sends them does so in some order of its own, which no
// browser produces.
//
// Listener wraps a net.Listener so that each HTTP/1.x connection records
// the header names of every request as they arrive on the wire; Handler
// attaches each request's recorded order to its context, where FromContext
// finds it (the upstream transport sends its headers in that order).
//
// HTTP/2 connections from the browser (a TLS deployment) are not covered:
// their header blocks are HPACK-coded inside the TLS stream. There the
// browser's own order is not recoverable this way.
package headerorder

import (
	"bytes"
	"context"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

type connKey struct{}
type orderKey struct{}

// conn records, for each request read from it, the header names in order.
type conn struct {
	net.Conn
	mu     sync.Mutex
	orders [][]string // completed header blocks not yet claimed, oldest first

	buf   []byte // bytes of the header block being read
	skip  int64  // body bytes still to pass over
	chunk chunkState
	dead  bool // stopped parsing (upgraded connection, or malformed input)
}

type chunkState int

const (
	noChunks chunkState = iota
	chunkSize
	chunkData
	chunkCRLF
	chunkTrailers
)

func (c *conn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 {
		c.mu.Lock()
		c.feed(p[:n])
		c.mu.Unlock()
	}
	return n, err
}

// feed advances the HTTP/1.x framing over b.
func (c *conn) feed(b []byte) {
	for len(b) > 0 && !c.dead {
		switch {
		case c.skip > 0:
			n := int64(len(b))
			if n > c.skip {
				n = c.skip
			}
			c.skip -= n
			b = b[n:]
			if c.skip == 0 && c.chunk == chunkData {
				c.chunk = chunkCRLF
			}
		case c.chunk == chunkCRLF, c.chunk == chunkSize, c.chunk == chunkTrailers:
			i := bytes.IndexByte(b, '\n')
			if i < 0 {
				c.buf = append(c.buf, b...)
				return
			}
			line := strings.TrimRight(string(append(c.buf, b[:i]...)), "\r")
			c.buf = c.buf[:0]
			b = b[i+1:]
			switch c.chunk {
			case chunkCRLF:
				c.chunk = chunkSize
			case chunkSize:
				size, perr := strconv.ParseInt(strings.TrimSpace(strings.SplitN(line, ";", 2)[0]), 16, 64)
				switch {
				case perr != nil || size < 0:
					c.dead = true
				case size == 0:
					c.chunk = chunkTrailers
				default:
					c.skip, c.chunk = size, chunkData
				}
			case chunkTrailers:
				if line == "" {
					c.chunk = noChunks
				}
			}
		default: // in a header block
			c.buf = append(c.buf, b...)
			b = nil
			end := bytes.Index(c.buf, []byte("\r\n\r\n"))
			if end < 0 {
				if len(c.buf) > 1<<20 {
					c.dead = true
				}
				return
			}
			rest := append([]byte(nil), c.buf[end+4:]...)
			c.header(string(c.buf[:end]))
			c.buf = c.buf[:0]
			b = rest
		}
	}
}

// header records one request's header names and sets up its body framing.
func (c *conn) header(block string) {
	lines := strings.Split(block, "\r\n")
	var names []string
	var length int64
	chunked, upgrade := false, false
	for _, l := range lines[1:] { // lines[0] is the request line
		name, value, ok := strings.Cut(l, ":")
		if !ok {
			continue
		}
		lname := strings.ToLower(strings.TrimSpace(name))
		names = append(names, lname)
		value = strings.TrimSpace(value)
		switch lname {
		case "content-length":
			length, _ = strconv.ParseInt(value, 10, 64)
		case "transfer-encoding":
			chunked = strings.Contains(strings.ToLower(value), "chunked")
		case "upgrade":
			upgrade = true
		}
	}
	c.orders = append(c.orders, names)
	switch {
	case upgrade, strings.HasPrefix(lines[0], "CONNECT "), strings.HasPrefix(lines[0], "PRI "):
		c.dead = true // no longer HTTP/1.x requests after this
	case chunked:
		c.chunk = chunkSize
	case length > 0:
		c.skip = length
	}
}

// next claims the oldest recorded order.
func (c *conn) next() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.orders) == 0 {
		return nil
	}
	o := c.orders[0]
	c.orders = c.orders[1:]
	return o
}

type listener struct{ net.Listener }

func (l listener) Accept() (net.Conn, error) {
	nc, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &conn{Conn: nc}, nil
}

// Listener wraps l so its connections record request header order.
func Listener(l net.Listener) net.Listener { return listener{l} }

// ConnContext is an http.Server.ConnContext: it makes the connection
// available to Handler.
func ConnContext(ctx context.Context, nc net.Conn) context.Context {
	if c, ok := nc.(*conn); ok {
		return context.WithValue(ctx, connKey{}, c)
	}
	return ctx
}

// Handler attaches to each request the header order its connection
// recorded for it. Requests on an HTTP/1.x connection are served one at a
// time, in the order they were read, so the oldest unclaimed record is
// this request's. Every request must pass through it to stay in step.
func Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if c, ok := r.Context().Value(connKey{}).(*conn); ok && r.ProtoMajor == 1 {
			// The record must be this request's: should the two ever fall
			// out of step (a request the server rejected before any
			// handler ran), skip records until one names this request's
			// headers.
			for o := c.next(); o != nil; o = c.next() {
				if matches(o, r) {
					r = r.WithContext(context.WithValue(r.Context(), orderKey{}, o))
					break
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// FromContext is the order (lowercase names) in which the browser sent the
// headers of the request ctx belongs to, or nil when it is not known.
func FromContext(ctx context.Context) []string {
	o, _ := ctx.Value(orderKey{}).([]string)
	return o
}

// Apply orders `have` (lowercase header names about to be sent) as the
// browser ordered them: names the browser sent, in its order; then names it
// did not send (added on the way), each placed where Chrome puts it when
// known — cookie before priority, at the end — or else at the end.
func Apply(browser, have []string) []string {
	present := make(map[string]bool, len(have))
	for _, h := range have {
		present[h] = true
	}
	out := make([]string, 0, len(have))
	used := make(map[string]bool, len(have))
	for _, h := range browser {
		if present[h] && !used[h] {
			out = append(out, h)
			used[h] = true
		}
	}
	var extra []string
	for _, h := range have {
		if !used[h] {
			extra = append(extra, h)
			used[h] = true
		}
	}
	if len(extra) == 0 {
		return out
	}
	// Chrome ends a request's headers with …, accept-encoding,
	// accept-language, cookie, priority.
	tail := map[string]int{"cookie": 1, "priority": 2}
	var late []string
	for _, h := range extra {
		if tail[h] == 0 {
			out = insertBeforeTail(out, h)
		} else {
			late = append(late, h)
		}
	}
	for _, want := range []string{"cookie", "priority"} {
		for _, h := range late {
			if h == want {
				if want == "cookie" {
					out = insertBefore(out, h, "priority")
				} else {
					out = append(out, h)
				}
			}
		}
	}
	return out
}

func insertBefore(list []string, h, before string) []string {
	for i, x := range list {
		if x == before {
			return append(list[:i], append([]string{h}, list[i:]...)...)
		}
	}
	return append(list, h)
}

// insertBeforeTail puts h before a trailing cookie/priority.
func insertBeforeTail(list []string, h string) []string {
	i := len(list)
	for i > 0 && (list[i-1] == "cookie" || list[i-1] == "priority") {
		i--
	}
	return append(list[:i], append([]string{h}, list[i:]...)...)
}

// matches: every header the record names is one the request has.
func matches(order []string, r *http.Request) bool {
	for _, name := range order {
		switch name {
		case "host", "content-length", "transfer-encoding", "connection":
			continue // held outside r.Header, or consumed by the server
		}
		if _, ok := r.Header[http.CanonicalHeaderKey(name)]; !ok {
			return false
		}
	}
	return true
}

// ChromeDefault orders `have` as Chrome typically does, for when the
// browser's own order is not known (it reached the proxy over HTTP/2).
// Measured from Chrome on the wire (tls.peet.ws): a navigation and a
// fetch/subresource request differ in where the client hints and
// user-agent go; headers set by page code follow content-type.
func ChromeDefault(have []string, navigation bool) []string {
	nav := []string{
		"content-length", "cache-control", "pragma", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "origin", "content-type",
		"upgrade-insecure-requests", "user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest",
		"sec-fetch-storage-access", "referer", "accept-encoding", "accept-language", "cookie", "priority",
	}
	other := []string{
		"content-length", "pragma", "cache-control", "sec-ch-ua-platform", "authorization", "user-agent", "sec-ch-ua", "content-type",
		"\x00custom", "dnt", "sec-ch-ua-mobile", "accept", "range", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest",
		"sec-fetch-storage-access", "referer", "accept-encoding", "accept-language", "if-none-match", "if-modified-since", "cookie", "priority",
	}
	tmpl := other
	if navigation {
		tmpl = nav
	}
	present := make(map[string]bool, len(have))
	for _, h := range have {
		present[h] = true
	}
	known := make(map[string]bool, len(tmpl))
	for _, h := range tmpl {
		known[h] = true
	}
	var custom []string
	for _, h := range have {
		if !known[h] {
			custom = append(custom, h)
		}
	}
	out := make([]string, 0, len(have))
	placed := false
	for _, h := range tmpl {
		switch {
		case h == "\x00custom":
			out = append(out, custom...)
			placed = true
		case present[h]:
			out = append(out, h)
		}
	}
	if !placed {
		out = insertAll(out, custom)
	}
	return out
}

func insertAll(list, extra []string) []string {
	for _, h := range extra {
		list = insertBeforeTail(list, h)
	}
	return list
}
