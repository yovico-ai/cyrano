// Package wsproxy proxies WebSocket connections from clients (browsers
// loading rewritten pages) to the original origin server.
//
// Architecture: hijack the client's TCP connection, dial the upstream,
// forward the rewritten Upgrade handshake, then bidirectionally pipe
// frames once the handshake completes. Stdlib only — no third-party
// websocket library, since we don't decode frames; we just shovel bytes.
//
// The wire-level URL containment is the same as HTTP: clients send
// `/cyrano/<scheme>/<host><path>` and we parse that on the upgrade request to
// find the upstream.
package wsproxy

import (
	"context"
	"github.com/yovico/cyrano/internal/tlsdial"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// Options configures one wsproxy handler.
type Options struct {
	SkipTLSVerify bool          // upstream TLS verification (false = verify)
	DialTimeout   time.Duration // upstream dial budget; default 10s
	HandshakeRead time.Duration // upstream handshake response read budget; default 15s
	Logger        *slog.Logger  // optional structured logger
}

// Handler upgrades incoming WebSocket requests and proxies them.
//
// Flow:
//  1. Parse /cyrano/<scheme>/<host><path> to find the upstream wss://... URL
//  2. http.Hijack the client connection
//  3. Dial upstream (TLS for wss, plain for ws)
//  4. Forward the client's Upgrade request, with Host/Origin rewritten
//  5. Stream the upstream's response back to the client (the 101 handshake)
//  6. Bidirectionally pipe bytes until either end closes
type Handler struct {
	opts Options
}

// New constructs a Handler with sensible defaults.
func New(opts Options) *Handler {
	if opts.DialTimeout == 0 {
		opts.DialTimeout = 10 * time.Second
	}
	if opts.HandshakeRead == 0 {
		opts.HandshakeRead = 15 * time.Second
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	return &Handler{opts: opts}
}

// IsWSUpgrade is true when the request looks like a WebSocket upgrade.
// Two header signals must agree: Upgrade: websocket and Connection: upgrade.
func IsWSUpgrade(r *http.Request) bool {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return false
	}
	for _, v := range r.Header.Values("Connection") {
		for _, t := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(t), "upgrade") {
				return true
			}
		}
	}
	return false
}

// ServeHTTP handles one WebSocket upgrade.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	target, ok := urlrewrite.ParseCyranoPath(r.URL.Path, r.URL.RawQuery)
	if !ok {
		http.Error(w, "missing or invalid /cyrano/ path for ws upgrade", http.StatusBadRequest)
		return
	}

	// Coerce HTTP/HTTPS to ws/wss — clients sometimes send http(s) cyrano values.
	switch target.Scheme {
	case "ws", "wss":
		// ok
	case "http":
		target.Scheme = "ws"
	case "https":
		target.Scheme = "wss"
	default:
		http.Error(w, "unsupported target scheme for ws", http.StatusBadRequest)
		return
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "websocket upgrade requires hijackable ResponseWriter", http.StatusInternalServerError)
		return
	}
	clientConn, clientBuf, err := hj.Hijack()
	if err != nil {
		h.opts.Logger.Warn("wsproxy: hijack failed", "err", err)
		http.Error(w, "hijack failed", http.StatusInternalServerError)
		return
	}
	defer clientConn.Close()

	upstream, err := h.dialUpstream(target)
	if err != nil {
		h.opts.Logger.Warn("wsproxy: upstream dial failed",
			"target", target.String(), "err", err)
		writeErrorResponse(clientConn, http.StatusBadGateway, "bad gateway: "+err.Error())
		return
	}
	defer upstream.Close()

	// Build the upstream upgrade request. Strip our local host bits and
	// substitute the original origin's so the upstream sees the handshake
	// it expects.
	upgradeReq := buildUpstreamRequest(r, target)
	if err := upgradeReq.Write(upstream); err != nil {
		h.opts.Logger.Warn("wsproxy: write upgrade request failed",
			"target", target.String(), "err", err)
		writeErrorResponse(clientConn, http.StatusBadGateway, "upstream write")
		return
	}

	// Pipe whatever's already buffered on the client side (may include
	// trailing bytes after the request headers — rare for WS, but Hijack
	// docs say we own it now).
	if clientBuf != nil && clientBuf.Reader.Buffered() > 0 {
		// Copy into upstream so the handshake header round-trip stays clean.
		if _, err := io.CopyN(upstream, clientBuf.Reader, int64(clientBuf.Reader.Buffered())); err != nil && err != io.EOF {
			h.opts.Logger.Debug("wsproxy: drain client buffer", "err", err)
		}
	}

	// Bidirectional copy. Each direction in its own goroutine; we exit
	// when either direction closes (CloseRead/CloseWrite would be nicer
	// but Conn doesn't expose them portably; close-on-defer is enough).
	errc := make(chan error, 2)
	go pipe(clientConn, upstream, errc)
	go pipe(upstream, clientConn, errc)
	<-errc
	h.opts.Logger.Debug("wsproxy: closed",
		"target", target.String())
}

func (h *Handler) dialUpstream(target *url.URL) (net.Conn, error) {
	host := target.Host
	if !strings.Contains(host, ":") {
		if target.Scheme == "wss" {
			host += ":443"
		} else {
			host += ":80"
		}
	}
	d := &net.Dialer{Timeout: h.opts.DialTimeout}

	if target.Scheme == "wss" {
		ctx, cancel := context.WithTimeout(context.Background(), h.opts.DialTimeout)
		defer cancel()
		return tlsdial.DialTLS(ctx, "tcp", host, h.opts.SkipTLSVerify)
	}
	return d.Dial("tcp", host)
}

// buildUpstreamRequest clones the inbound request with rewritten Host and
// the upstream path/query restored. We keep the WebSocket upgrade headers
// (Sec-WebSocket-*) verbatim — those are end-to-end client⟷upstream.
func buildUpstreamRequest(in *http.Request, target *url.URL) *http.Request {
	out := in.Clone(in.Context())
	out.URL = &url.URL{
		Path:     target.Path,
		RawPath:  target.RawPath,
		RawQuery: target.RawQuery,
	}
	if out.URL.Path == "" {
		out.URL.Path = "/"
	}
	out.Host = target.Host
	out.Header = in.Header.Clone()

	// Drop our own forwarding/proxy markers so upstream sees a clean handshake.
	out.Header.Del("X-Forwarded-For")
	out.Header.Del("X-Forwarded-Proto")
	out.Header.Del("X-Forwarded-Port")
	out.Header.Del("X-Forwarded-Host")

	// Rewrite Origin: the page running on our proxy origin can declare its
	// real origin as the original site's; otherwise upstream's origin
	// allowlist will reject.
	if origin := target.Scheme + "://" + target.Host; out.Header.Get("Origin") != "" {
		out.Header.Set("Origin", origin)
	}

	// http.Request.Write needs RequestURI cleared (it constructs one).
	out.RequestURI = ""
	return out
}

// pipe shovels bytes from src to dst, signaling completion (or first
// error) on errc. Uses a moderately sized buffer to keep tiny WS frames
// from each fragmenting into their own syscall.
func pipe(dst io.Writer, src io.Reader, errc chan<- error) {
	buf := make([]byte, 32*1024)
	_, err := io.CopyBuffer(dst, src, buf)
	errc <- err
}

func writeErrorResponse(c net.Conn, status int, msg string) {
	body := msg + "\n"
	fmt.Fprintf(c,
		"HTTP/1.1 %d %s\r\n"+
			"Content-Type: text/plain\r\n"+
			"Content-Length: %d\r\n"+
			"Connection: close\r\n"+
			"\r\n%s",
		status, http.StatusText(status), len(body), body)
}

