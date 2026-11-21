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
	"github.com/bogdanfinn/fhttp/httptrace"
	"github.com/yovico/cyrano/internal/dnscache"
	"github.com/yovico/cyrano/internal/headerorder"
	"github.com/yovico/cyrano/internal/urlrewrite"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
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

	mu        sync.Mutex
	clients   map[string]*clientEntry // "sessionID\x00profileKey" → client
	lastSweep time.Time

	// Intermediates completed from AIA, as Chrome does (aia.go) — per
	// session: no session's visits change another's connections.
	aia map[string]*aiaState
}

// NewRoundTripper returns a RoundTripper. skipVerify disables upstream TLS
// certificate verification (dev-only; wired from the --insecure flag).
func NewRoundTripper(skipVerify bool) *RoundTripper {
	return &RoundTripper{
		skipVerify: skipVerify,
		clients: make(map[string]*clientEntry),
		aia:     make(map[string]*aiaState),
	}
}

// RoundTrip sends req through the browser-impersonating client.
// ConnInfo, put in a request's context under ConnInfoKey, is filled with
// the connection that carried the request.
type ConnInfo struct {
	Local, Remote string
	Reused        bool
}

// ConnInfoKey is the context key of a *ConnInfo.
type ConnInfoKey struct{}

func (rt *RoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	// http: as well as https: goes through the browser-impersonating client:
	// over HTTP/1.1 with Chrome's head (h1head.go), as a direct Chrome's. Go's
	// own transport wrote its own header order and Go's casing to every http
	// origin.

	profileKey, profile := selectProfile(req.Header.Get("User-Agent"))
	// Scope the connection pool to the browser session: each session gets its
	// own impersonation client (and thus its own h2 connections), so requests
	// within a session reuse/multiplex while sessions stay isolated from one
	// another. Session-less requests (pre-login navigations, static probes)
	// share the "" bucket; they carry no session credentials.
	//
	// And per host: the impersonation client holds one lock across the whole
	// first dial (DNS, TCP, TLS handshake) to any new host, so one client per
	// session made a page's hundreds of hosts connect one after another —
	// seconds, by which time header-bidding auctions had given up. Its
	// connection pool is per host anyway; per-host clients only stop the
	// hosts from waiting for each other.
	sessionID, _ := req.Context().Value(SessionKey{}).(string)
	// And per scheme: the client keeps one transport per host and port as
	// it dials them, defaulting the port to 443, so an http: request after
	// an https: one to the same host met the HTTP/2 transport ("http2:
	// unsupported scheme").
	clientKey := sessionID + "\x00" + profileKey + "\x00" + strings.ToLower(req.URL.Scheme) + "://" + strings.ToLower(req.URL.Host)
	client, err := rt.clientFor(clientKey, profile)
	if err != nil {
		return nil, err
	}

	// Which connection carries the request (debug: a challenge's clearance
	// is bound to the client address; see ConnInfo).
	ctx := req.Context()
	info, _ := ctx.Value(ConnInfoKey{}).(*ConnInfo)
	var fReq *fhttp.Request
	// Once the connection is up — its protocol known, nothing written yet:
	// over HTTP/1.1 the head takes Chrome's HTTP/1.1 form (h1head.go).
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{GotConn: func(g httptrace.GotConnInfo) {
		if info != nil {
			info.Reused = g.Reused
			if g.Conn != nil {
				info.Local, info.Remote = g.Conn.LocalAddr().String(), g.Conn.RemoteAddr().String()
			}
		}
		if fReq != nil && overHTTP1(g.Conn) {
			host := fReq.Host
			if host == "" {
				host = fReq.URL.Host
			}
			asHTTP1(fReq.Header, host)
		}
	}})
	fReq, err = fhttp.NewRequestWithContext(ctx, req.Method, req.URL.String(), req.Body)
	if err != nil {
		return nil, err
	}
	if p := exactPath(req.URL); p != "" {
		fReq.URL.Opaque = p
	}
	fReq.Host = req.Host
	fReq.ContentLength = req.ContentLength
	copyHeaders(fReq.Header, req)

	// Header order is part of the fingerprint. Send the headers in the
	// order the browser itself sent them (recorded on its connection:
	// headerorder), which is exact for any request and any page code; when
	// that is not known (the browser reached the proxy over HTTP/2), in
	// Chrome's usual order for the kind of request. Pseudo-header order and
	// H2 SETTINGS come from the client profile.
	names := make([]string, 0, len(fReq.Header))
	for k := range fReq.Header {
		if strings.Contains(k, ":") { // skip Header-Order:/PHeader-Order:/pseudo-headers
			continue
		}
		names = append(names, strings.ToLower(k))
	}
	sort.Strings(names) // a stable starting point
	if order := headerorder.FromContext(req.Context()); order != nil {
		names = headerorder.Apply(order, names)
	} else {
		names = headerorder.ChromeDefault(names, strings.EqualFold(req.Header.Get("Sec-Fetch-Mode"), "navigate"))
	}
	fReq.Header[fhttp.HeaderOrderKey] = names

	fResp, err := client.Do(fReq)
	// A chain the server sent short: complete it from AIA, as Chrome does,
	// and try once more (a request whose body can be sent again).
	if err != nil && !rt.skipVerify && (req.Body == nil || req.Body == http.NoBody) && rt.aiaFor(sessionID).complete(err) {
		rt.dropClients(sessionID)
		if client, err = rt.clientFor(clientKey, profile); err != nil {
			return nil, err
		}
		fResp, err = client.Do(fReq)
	}
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

// exactPath is the request path to put on the wire byte for byte — the
// URL's RawPath as cyrano set it from the browser's own URL (it may hold
// what net/url would re-escape: "/100%.jpg", "/a^|") — or "" to let the
// transport serialize the path itself. A path starting "//" cannot go on the
// wire as URL.Opaque (it would read as an authority); see CLAUDE.md.
func exactPath(u *url.URL) string {
	p := u.RawPath
	if p == "" || strings.HasPrefix(p, "//") {
		return ""
	}
	return p
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
		tls_client.WithDialContext((&dnscache.Dialer{Dialer: net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}}).DialContext),
		tls_client.WithTransportOptions(&tls_client.TransportOptions{
			RootCAs:             rt.aiaLocked(sessionOfKey(key)).pool(), // nil: the system's; plus this session's AIA-completed intermediates
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

// dropClients forgets a session's clients (their pooled connections
// closed), so its next ones verify with its current root pool.
func (rt *RoundTripper) dropClients(session string) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	for k, e := range rt.clients {
		if sessionOfKey(k) == session {
			e.client.CloseIdleConnections()
			delete(rt.clients, k)
		}
	}
}

// aiaFor is a session's AIA state.
func (rt *RoundTripper) aiaFor(session string) *aiaState {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.aiaLocked(session)
}

func (rt *RoundTripper) aiaLocked(session string) *aiaState {
	a, ok := rt.aia[session]
	if !ok {
		a = newAIAState()
		rt.aia[session] = a
	}
	return a
}

// sessionOfKey is the session a client key ("session\x00profile\x00host") is for.
func sessionOfKey(key string) string {
	if i := strings.IndexByte(key, 0); i >= 0 {
		return key[:i]
	}
	return key
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
	// A session with no clients left keeps no AIA state either.
	live := make(map[string]bool, len(rt.clients))
	for k := range rt.clients {
		live[sessionOfKey(k)] = true
	}
	for sess := range rt.aia {
		if !live[sess] {
			delete(rt.aia, sess)
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
	major, err := strconv.Atoi(m[1])
	if err != nil {
		return
	}
	h.Set("Sec-Ch-Ua", SecChUa(major, "Google Chrome"))
	h.Set("Sec-Ch-Ua-Mobile", "?0")
	h.Set("Sec-Ch-Ua-Platform", `"`+chromePlatform(ua)+`"`)
}

// SecChUa is the low-entropy Sec-CH-UA a Chrome of this major version
// sends (spec/Hints.agda secChUa, as Chromium makes it: the GREASE brand,
// its version and the brands' order all follow from the version; checked
// against Chromium). A fixed GREASE brand matched only some versions.
func SecChUa(major int, product string) string {
	chars := []string{" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"}
	versions := []string{"8", "99", "24"}
	orders := [6][3]int{{0, 1, 2}, {0, 2, 1}, {1, 0, 2}, {1, 2, 0}, {2, 0, 1}, {2, 1, 0}}
	v := strconv.Itoa(major)
	entries := [3]string{
		`"Not` + chars[major%11] + "A" + chars[(major+1)%11] + `Brand";v="` + versions[major%3] + `"`,
		`"Chromium";v="` + v + `"`,
		`"` + product + `";v="` + v + `"`,
	}
	var out [3]string
	for i, pos := range orders[major%6] {
		out[pos] = entries[i]
	}
	return out[0] + ", " + out[1] + ", " + out[2]
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

// copyHeaders sets the upstream request's headers from the proxy's.
func copyHeaders(out fhttp.Header, req *http.Request) {
	// Copy headers. A nil value slice (cyrano suppresses X-Forwarded-For by
	// setting it to nil) contributes nothing, preserving the suppression.
	// Skip framing/hop-by-hop headers the transport owns: copying Content-Length
	// here duplicates it against fReq.ContentLength, producing a request with two
	// Content-Length headers — a smuggling signature that upstreams (Cloudflare)
	// reject with a 400. That silently broke every POST (GETs, having no body,
	// were unaffected).
	// To a target that is not potentially trustworthy (an http name) a
	// direct browser sends no fetch metadata and no client hints
	// (spec/Metadata.agda); the browser sent them to the proxy.
	trustworthy := urlrewrite.Trustworthy(req.URL)
	for k, vs := range req.Header {
		switch k {
		case "Content-Length", "Host", "Transfer-Encoding", "Connection":
			continue
		}
		if !trustworthy && urlrewrite.SecureOnlyHeader(k) {
			continue
		}
		for _, v := range vs {
			out.Add(k, v)
		}
	}
	// Real Chrome sends these low-entropy Sec-CH-UA-* hints on every request,
	// same-origin or not — their total absence on a request whose UA claims
	// Chrome is itself a bot signal fingerprinting WAFs check for. Some
	// automation-driven Chrome configurations (e.g. certain headless/CDP
	// setups) omit them even though the real browser sends them normally, so
	// synthesize them from the UA when the incoming request didn't carry any.
	// Only for a potentially trustworthy target: to an http name a direct
	// browser sends no client hints at all (spec/Metadata.agda).
	if trustworthy {
		ensureClientHints(out, req.Header.Get("User-Agent"))
	}
}
