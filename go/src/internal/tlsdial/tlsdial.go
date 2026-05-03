// Package tlsdial provides a TLS dialer that impersonates Chrome's TLS
// ClientHello using uTLS. This makes the proxy's outbound connections
// indistinguishable from a real browser at the TLS fingerprint level (JA3/JA4),
// which is the primary signal used by WAFs (Akamai, Cloudflare, etc.) to
// identify automated clients.
//
// ALPN is limited to ["http/1.1"]: Go's http.Transport type-asserts the TLS
// connection to *tls.Conn to enable HTTP/2, which fails for utls.UConn. If h2
// were offered and the server selected it, the server would send HTTP/2 frames
// that Go's HTTP/1.x parser rejects as a 502. The JA3 fingerprint is
// unaffected — it hashes extension IDs, not extension values.
package tlsdial

import (
	"context"
	"net"
	"time"

	utls "github.com/refraction-networking/utls"
)

const handshakeTimeout = 10 * time.Second

// newUConn builds a uTLS UConn that impersonates Chrome's TLS ClientHello
// with ALPN restricted to http/1.1 (see package comment).
func newUConn(rawConn net.Conn, host string, skipVerify bool) (*utls.UConn, error) {
	// UTLSIdToSpec returns a fresh spec each call, so it is safe to mutate.
	spec, err := utls.UTLSIdToSpec(utls.HelloChrome_Auto)
	if err != nil {
		return nil, err
	}
	for i, ext := range spec.Extensions {
		if _, ok := ext.(*utls.ALPNExtension); ok {
			spec.Extensions[i] = &utls.ALPNExtension{AlpnProtocols: []string{"http/1.1"}}
			break
		}
	}
	cfg := &utls.Config{
		ServerName:         host,
		InsecureSkipVerify: skipVerify, // nosemgrep: gosec.G402.tls-unsafe-config — dev-only flag
	}
	uconn := utls.UClient(rawConn, cfg, utls.HelloCustom)
	if err := uconn.ApplyPreset(&spec); err != nil {
		return nil, err
	}
	return uconn, nil
}

// DialTLS opens a TCP connection to addr and completes a TLS handshake using
// Chrome's ClientHello fingerprint. Suitable for use as
// http.Transport.DialTLSContext and for direct callers (e.g. wsproxy WSS).
func DialTLS(ctx context.Context, network, addr string, skipVerify bool) (net.Conn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	rawConn, err := (&net.Dialer{}).DialContext(ctx, network, addr)
	if err != nil {
		return nil, err
	}
	uconn, err := newUConn(rawConn, host, skipVerify)
	if err != nil {
		rawConn.Close()
		return nil, err
	}
	hCtx, cancel := context.WithTimeout(ctx, handshakeTimeout)
	defer cancel()
	if err := uconn.HandshakeContext(hCtx); err != nil {
		rawConn.Close()
		return nil, err
	}
	return uconn, nil
}

// NewDialTLSContext returns a DialTLSContext function for use in
// http.Transport. The provided net.Dialer controls TCP-level settings
// (timeouts, keep-alive); TLS is layered on top using Chrome's fingerprint.
func NewDialTLSContext(tcpDialer *net.Dialer, skipVerify bool) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		rawConn, err := tcpDialer.DialContext(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		uconn, err := newUConn(rawConn, host, skipVerify)
		if err != nil {
			rawConn.Close()
			return nil, err
		}
		hCtx, cancel := context.WithTimeout(ctx, handshakeTimeout)
		defer cancel()
		if err := uconn.HandshakeContext(hCtx); err != nil {
			rawConn.Close()
			return nil, err
		}
		return uconn, nil
	}
}
