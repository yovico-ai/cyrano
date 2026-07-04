// Package upstream provides the outbound HTTP round-tripper used by the proxy
// to reach upstream origins. For https targets it dispatches through a
// browser-impersonating TLS + HTTP/2 client (uTLS + fhttp, via tls-client) so
// the proxy's connections match a real Chrome at the JA3/JA4 and HTTP/2
// (Akamai) fingerprint level — the primary signals WAFs (Cloudflare, Akamai)
// use to distinguish automated clients from browsers. Plaintext http targets
// carry no TLS fingerprint, so they use a stdlib transport; this also keeps
// the plaintext httptest servers in the test suite on a well-understood path.
//
// The impersonation client is deliberately NOT given a cookie jar: cyrano owns
// all cookie state (site-namespaced in the browser plus the server-side
// SessionJar), so the transport must never store or replay Set-Cookie itself.
// Redirects are likewise not followed here — httputil.ReverseProxy passes 3xx
// responses through to the browser, which re-issues the navigation via the
// proxy.
package upstream

import (
	"net"
	"net/http"
	"net/textproto"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

// SessionKey is the request-context key under which the proxy stashes the
// browser session ID (the crnsct value). RoundTrip reads it to give each
// session its own impersonation client — hence its own HTTP/2 connection
// pool — so upstream connections are reused/multiplexed WITHIN a session
// (browser-like) but never shared ACROSS sessions. The proxy package sets
// this in its Director; defining the key here (not in proxy) avoids an
// import cycle, since proxy already imports upstream.
type SessionKey struct{}

// Client-eviction cadence. Per-session clients accumulate as sessions come
// and go; a client idle longer than clientTTL is closed and dropped. The
// sweep is opportunistic (run under mu on clientFor) so there's no background
// goroutine to leak — important because tests construct RoundTrippers freely.
const (
	clientTTL     = 10 * time.Minute
	sweepInterval = 1 * time.Minute
)

type clientEntry struct {
	client   tls_client.HttpClient
	lastUsed time.Time
}

// RoundTripper implements http.RoundTripper by fanning https requests out to a
// per-(session, profile) pool of Chrome-impersonating clients and http requests
// to a stdlib transport. A single RoundTripper is created once at server
// startup and shared across all requests, so each session's connection pool
// persists between its requests (that persistence is what makes HTTP/2
// connection reuse possible at all). Safe for concurrent use.
type RoundTripper struct {
	skipVerify bool
	plain      *http.Transport

	mu        sync.Mutex
	clients   map[string]*clientEntry // "sessionID\x00profileKey" → client
	lastSweep time.Time
}

// NewRoundTripper returns a RoundTripper. skipVerify disables upstream TLS
// certificate verification (dev-only; wired from the --insecure flag).
func NewRoundTripper(skipVerify bool) *RoundTripper {
	tcpDialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	return &RoundTripper{
		skipVerify: skipVerify,
		plain: &http.Transport{
			DialContext:           tcpDialer.DialContext,
			MaxIdleConns:          100,
			MaxIdleConnsPerHost:   8,
			IdleConnTimeout:       90 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
			ResponseHeaderTimeout: 15 * time.Second,
		},
		clients: make(map[string]*clientEntry),
	}
}

// RoundTrip dispatches req to the browser-impersonating client (https) or the
// stdlib transport (everything else).
func (rt *RoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Scheme != "https" {
		return rt.plain.RoundTrip(req)
	}

	profileKey, profile := selectProfile(req.Header.Get("User-Agent"))
	// Scope the connection pool to the browser session: each session gets its
	// own impersonation client (and thus its own h2 connections), so requests
	// within a session reuse/multiplex while sessions stay isolated from one
	// another. Session-less requests (pre-login navigations, static probes)
	// share the "" bucket; they carry no session credentials.
	sessionID, _ := req.Context().Value(SessionKey{}).(string)
	client, err := rt.clientFor(sessionID+"\x00"+profileKey, profile)
	if err != nil {
		return nil, err
	}

	fReq, err := fhttp.NewRequestWithContext(req.Context(), req.Method, req.URL.String(), req.Body)
	if err != nil {
		return nil, err
	}
	fReq.Host = req.Host
	fReq.ContentLength = req.ContentLength
	// Copy headers. A nil value slice (cyrano suppresses X-Forwarded-For by
	// setting it to nil) contributes nothing, preserving the suppression.
	// Skip framing/hop-by-hop headers the transport owns: copying Content-Length
	// here duplicates it against fReq.ContentLength, producing a request with two
	// Content-Length headers — a smuggling signature that upstreams (Cloudflare)
	// reject with a 400. That silently broke every POST (GETs, having no body,
	// were unaffected).
	for k, vs := range req.Header {
		switch k {
		case "Content-Length", "Host", "Transfer-Encoding", "Connection":
			continue
		}
		for _, v := range vs {
			fReq.Header.Add(k, v)
		}
	}
	// Real Chrome sends these low-entropy Sec-CH-UA-* hints on every request,
	// same-origin or not — their total absence on a request whose UA claims
	// Chrome is itself a bot signal fingerprinting WAFs check for. Some
	// automation-driven Chrome configurations (e.g. certain headless/CDP
	// setups) omit them even though the real browser sends them normally, so
	// synthesize them from the UA when the incoming request didn't carry any.
	ensureClientHints(fReq.Header, req.Header.Get("User-Agent"))

	// Impose Chrome's request header order. Modern Chrome (verified against a
	// real Chrome 139 capture) emits HTTP/2 request headers in ALPHABETICAL
	// order — not a fixed template — so per-request headers (custom X-*, trace,
	// origin, priority, cookie) always land in their sorted position. A fixed
	// list misorders those and stands out in Cloudflare's HPACK header-order
	// fingerprint, which is what challenges cyrano's leg while a direct browser
	// on the same IP passes. Pseudo-header order + H2 SETTINGS come from the
	// client profile; here we order only the regular headers.
	names := make([]string, 0, len(fReq.Header))
	for k := range fReq.Header {
		if strings.Contains(k, ":") { // skip Header-Order:/PHeader-Order:/pseudo-headers
			continue
		}
		names = append(names, strings.ToLower(k))
	}
	sort.Strings(names)
	fReq.Header[fhttp.HeaderOrderKey] = names

	fResp, err := client.Do(fReq)
	if err != nil {
		return nil, err
	}

	return &http.Response{
		Status:           fResp.Status,
		StatusCode:       fResp.StatusCode,
		Proto:            fResp.Proto,
		ProtoMajor:       fResp.ProtoMajor,
		ProtoMinor:       fResp.ProtoMinor,
		Header:           convertHeader(fResp.Header),
		Body:             fResp.Body,
		ContentLength:    fResp.ContentLength,
		TransferEncoding: fResp.TransferEncoding,
		Close:            fResp.Close,
		Uncompressed:     fResp.Uncompressed,
		// Downstream (ModifyResponse) reads resp.Request for the session ID and
		// upstream URL, so it must be the original stdlib request.
		Request: req,
	}, nil
}

// clientFor returns the cached impersonation client for the given cache key
// (session-scoped; see RoundTrip), creating it on first use.
func (rt *RoundTripper) clientFor(key string, profile profiles.ClientProfile) (tls_client.HttpClient, error) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	now := time.Now()
	rt.sweepLocked(now)
	if e, ok := rt.clients[key]; ok {
		e.lastUsed = now
		return e.client, nil
	}
	idle := 90 * time.Second
	opts := []tls_client.HttpClientOption{
		tls_client.WithClientProfile(profile),
		tls_client.WithNotFollowRedirects(),
		// No overall timeout: rely on the request context (cancelled when the
		// browser disconnects) so large/streamed downloads aren't cut off.
		tls_client.WithTimeoutSeconds(0),
		// H3 only kicks in after Alt-Svc; a real Chrome's first contact is h2.
		// Keeping to h2/h1 makes the outbound path predictable.
		tls_client.WithDisableHttp3(),
		tls_client.WithDialer(net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}),
		tls_client.WithTransportOptions(&tls_client.TransportOptions{
			MaxIdleConns:        100,
			MaxIdleConnsPerHost: 8,
			IdleConnTimeout:     &idle,
			// cyrano owns decompression: it rewrites response bodies and
			// decodes gzip/br/zstd itself (server.readDecompressedBody). fhttp,
			// unlike stdlib net/http, auto-decompresses whenever the caller's
			// Accept-Encoding merely contains "gzip" — which would unwrap the
			// body while leaving Content-Encoding, so our decoder then fails on
			// already-plaintext bytes ("magic number mismatch"). Disable it; our
			// explicit Accept-Encoding still goes out on the wire so the upstream
			// sees a browser-like header and responds compressed.
			DisableCompression: true,
		}),
	}
	if rt.skipVerify {
		opts = append(opts, tls_client.WithInsecureSkipVerify())
	}
	c, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(), opts...)
	if err != nil {
		return nil, err
	}
	rt.clients[key] = &clientEntry{client: c, lastUsed: now}
	return c, nil
}

// sweepLocked evicts session clients idle longer than clientTTL, closing their
// pooled connections. Runs at most once per sweepInterval. Caller holds rt.mu.
func (rt *RoundTripper) sweepLocked(now time.Time) {
	if now.Sub(rt.lastSweep) < sweepInterval {
		return
	}
	rt.lastSweep = now
	for k, e := range rt.clients {
		if now.Sub(e.lastUsed) > clientTTL {
			e.client.CloseIdleConnections()
			delete(rt.clients, k)
		}
	}
}

var chromeUARe = regexp.MustCompile(`Chrome/(\d+)`)

// ensureClientHints sets the low-entropy Sec-CH-UA* headers from ua when h
// doesn't already carry them. Real Chrome attaches these to every request
// (same-origin or not) unconditionally; arriving with a Chrome User-Agent and
// no client hints at all is itself an anomaly WAFs fingerprint on.
func ensureClientHints(h fhttp.Header, ua string) {
	if h.Get("Sec-Ch-Ua") != "" {
		return
	}
	m := chromeUARe.FindStringSubmatch(ua)
	if m == nil {
		return
	}
	major := m[1]
	h.Set("Sec-Ch-Ua", `"Not)A;Brand";v="8", "Chromium";v="`+major+`", "Google Chrome";v="`+major+`"`)
	h.Set("Sec-Ch-Ua-Mobile", "?0")
	h.Set("Sec-Ch-Ua-Platform", `"`+chromePlatform(ua)+`"`)
}

// chromePlatform maps common UA platform tokens to the string real Chrome
// reports in Sec-Ch-Ua-Platform.
func chromePlatform(ua string) string {
	switch {
	case strings.Contains(ua, "Windows"):
		return "Windows"
	case strings.Contains(ua, "Mac OS X"):
		return "macOS"
	case strings.Contains(ua, "Android"):
		return "Android"
	case strings.Contains(ua, "CrOS"):
		return "Chrome OS"
	default:
		return "Linux"
	}
}

// selectProfile maps the incoming User-Agent's Chrome major version to the
// nearest available impersonation profile, so the outbound fingerprint matches
// the browser the request claims to be. Non-Chrome or unparseable UAs fall
// back to the latest profile.
func selectProfile(ua string) (string, profiles.ClientProfile) {
	if m := chromeUARe.FindStringSubmatch(ua); m != nil {
		if v, err := strconv.Atoi(m[1]); err == nil {
			switch {
			case v >= 146:
				return "chrome146", profiles.Chrome_146
			case v >= 133:
				// 133..145 → Chrome_144: its ClientHello (post-quantum key share,
				// ECH GREASE, extension set) tracks current Chrome far better than
				// the stale Chrome_133 profile, which Cloudflare flags as a
				// non-browser TLS fingerprint against a modern Chrome UA.
				return "chrome144", profiles.Chrome_144
			case v >= 131:
				return "chrome131", profiles.Chrome_131
			case v >= 124:
				return "chrome124", profiles.Chrome_124
			case v >= 120:
				return "chrome120", profiles.Chrome_120
			}
		}
	}
	return "chrome146", profiles.Chrome_146
}

// convertHeader copies an fhttp response header into a stdlib header with
// canonicalised keys, so downstream Header.Get lookups (which canonicalise the
// key) resolve regardless of the casing fhttp preserved on the wire.
func convertHeader(h fhttp.Header) http.Header {
	out := make(http.Header, len(h))
	for k, vs := range h {
		ck := textproto.CanonicalMIMEHeaderKey(k)
		out[ck] = append(out[ck], vs...)
	}
	return out
}
