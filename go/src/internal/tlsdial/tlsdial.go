// Package tlsdial provides a TLS dialer that impersonates Chrome's TLS
// ClientHello using uTLS. This makes the proxy's outbound connections
// indistinguishable from a real browser at the TLS fingerprint level (JA3/JA4),
// which is the primary signal used by WAFs (Akamai, Cloudflare, etc.) to
// identify automated clients.
package tlsdial

import (
	"context"
	"net"
	"time"

	utls "github.com/refraction-networking/utls"
)

const handshakeTimeout = 10 * time.Second

// DialTLS opens a TCP connection to addr and completes a TLS handshake using
// Chrome's ClientHello fingerprint. It is safe for use as
// http.Transport.DialTLSContext and can also be called directly (e.g. for
// WebSocket over TLS). skipVerify disables certificate validation (dev only).
func DialTLS(ctx context.Context, network, addr string, skipVerify bool) (net.Conn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}

	dialer := &net.Dialer{}
	rawConn, err := dialer.DialContext(ctx, network, addr)
	if err != nil {
		return nil, err
	}

	cfg := &utls.Config{
		ServerName:         host,
		InsecureSkipVerify: skipVerify, // nosemgrep: gosec.G402.tls-unsafe-config — dev-only flag
	}

	uconn := utls.UClient(rawConn, cfg, utls.HelloChrome_Auto)

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

		cfg := &utls.Config{
			ServerName:         host,
			InsecureSkipVerify: skipVerify, // nosemgrep: gosec.G402.tls-unsafe-config — dev-only flag
		}

		uconn := utls.UClient(rawConn, cfg, utls.HelloChrome_Auto)

		hCtx, cancel := context.WithTimeout(ctx, handshakeTimeout)
		defer cancel()

		if err := uconn.HandshakeContext(hCtx); err != nil {
			rawConn.Close()
			return nil, err
		}

		return uconn, nil
	}
}
