// Package proxy is the upstream-fetch leg of the rewriter pipeline. It
// decodes the URL-containment scheme (`/cyrano/<scheme>/<host><path>`), opens
// a connection to the original host, and streams the response back to the
// client.
//
// Phase 2 only: pass-through. No body rewriting happens here yet — that
// belongs to a wrapper handler in phase 3 that pipes the response through
// the HTML/JS/CSS rewriters before flushing it to the client.
package proxy

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/yovico/cyrano/internal/upstream"
	"github.com/yovico/cyrano/internal/urlrewrite"
)

// Options configures one proxy handler instance.
type Options struct {
	// SkipTLSVerify disables upstream TLS certificate validation. Only enable
	// in dev — production must validate.
	SkipTLSVerify bool

	// Timeout is the total request budget for one upstream fetch. Default 15s.
	Timeout time.Duration

	// Logger receives structured upstream events.
	Logger *slog.Logger

	// BodyRewriter, if non-nil, is invoked from ModifyResponse after the
	// upstream response headers arrive. It may replace resp.Body with a
	// wrapped reader (e.g. piping the body through the HTML/JS/CSS
	// rewriters). The target URL — the /cyrano/ decoded URL — is the
	// page's *original* URL and should be the BaseURL for any rewriters.
	//
	// nil = pure pass-through (phase 2 behavior).
	BodyRewriter func(resp *http.Response, target *url.URL) error

	// ProxyCfg is the URL-containment config used to rewrite redirect-
	// response headers (Location, Content-Location) so the browser follows
	// upstream 30x redirects through the proxy instead of escaping to the
	// origin. Zero value (no PublicURL) disables redirect rewriting and
	// passes Location headers through verbatim — fine only for tests that
	// don't exercise redirects.
	ProxyCfg urlrewrite.ProxyConfig

	// CookieJar, when non-nil, enables server-side HttpOnly cookie storage.
	// HttpOnly cookies from upstream responses are stored here instead of
	// being forwarded to the browser; they are injected back into outgoing
	// requests automatically. Non-HttpOnly cookies continue to be forwarded
	// to the browser with the usual name-prefix rewrite.
	CookieJar *SessionJar

	// SessionCookieName is the name of the proxy-issued session-ID cookie
	// (e.g. "crnsct"). Used as the key into CookieJar. Has no effect when
	// CookieJar is nil.
	SessionCookieName string

	// Transport, when non-nil, is the upstream RoundTripper this handler
	// dispatches through. It MUST be shared across requests (created once at
	// server startup) so the per-session HTTP/2 connection pools persist and
	// connections get reused/multiplexed instead of one-per-request. When nil,
	// New creates a fresh RoundTripper — convenient for tests, but never do
	// that on the hot path: a per-request transport discards its pool every
	// request, dialing a new upstream connection for every fetch.
	Transport http.RoundTripper
}

// SessionContextKey is the context key used to propagate the proxy session ID
// from Director to ModifyResponse and the body rewriter.
type SessionContextKey struct{}

// Handler decodes /cyrano/ paths and proxies. It implements http.Handler so it
// can be mounted into an http.ServeMux directly.
type Handler struct {
	opts      Options
	transport http.RoundTripper
}

// New constructs a Handler with sensible defaults applied.
func New(opts Options) *Handler {
	if opts.Timeout == 0 {
		opts.Timeout = 15 * time.Second
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	// Browser-impersonating upstream transport: https targets negotiate a real
	// Chrome JA3/JA4 + HTTP/2 fingerprint (via uTLS + fhttp), plaintext http
	// targets use a stdlib transport. See the upstream package doc. A shared
	// transport MUST be injected via Options.Transport so connection pools
	// persist across requests; the fallback here is for tests only.
	t := opts.Transport
	if t == nil {
		t = upstream.NewRoundTripper(opts.SkipTLSVerify)
	}
	return &Handler{opts: opts, transport: t}
}

// hopByHopHeaders are connection-scoped and must not propagate end-to-end.
// httputil.ReverseProxy already handles most of these; listed here for
// belt-and-suspenders in case we ever bypass the stdlib reverse-proxy path.
var hopByHopHeaders = []string{
	"Connection", "Proxy-Connection", "Keep-Alive",
	"Proxy-Authenticate", "Proxy-Authorization",
	"Te", "Trailer", "Transfer-Encoding", "Upgrade",
}

// No response header is dropped: a page's scripts read them (fetch, XHR),
// and a missing header is a difference they can see. Headers the browser
// must not act on as the origin wrote them are changed, and the origin's
// value is carried alongside for scripts (original_headers.go):
//
//   - Alt-Svc would send the browser to another endpoint for the *proxy's*
//     origin: it is told "clear".
//   - Content-Security-Policy, Referrer-Policy, Accept-CH,
//     Permissions-Policy, Location, Link, Refresh: translated elsewhere.
//
// Passed through as they are: Strict-Transport-Security (ignored over
// plain HTTP; behind TLS it concerns the proxy's own host),
// Public-Key-Pins (no browser acts on it), Cross-Origin-Opener-Policy and
// Cross-Origin-Embedder-Policy (together they make the page cross-origin
// isolated, which its scripts can see — Cloudflare sets both on challenge
// pages; on the proxy every proxied resource is same-origin, so COEP is
// satisfied by anything proxied).

// dropOnRequest are headers we never forward upstream — they leak the proxy
// origin or carry session-scoped data we manage ourselves.
var dropOnRequest = []string{
	"X-Forwarded-For",
	"X-Forwarded-Proto",
	"X-Forwarded-Port",
	"X-Forwarded-Host",
	"Forwarded",
}

// ServeHTTP routes one proxified request.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	target, ok := urlrewrite.ParseCyranoURL(r.URL)
	if !ok {
		http.Error(w, "invalid /cyrano/ path", http.StatusBadRequest)
		return
	}
	switch target.Scheme {
	case "http", "https":
		// ok
	case "ws", "wss":
		// Phase 5 territory — WebSocket upgrades follow a different path.
		http.Error(w, "websocket proxying not yet implemented", http.StatusNotImplemented)
		return
	default:
		http.Error(w, "unsupported target scheme", http.StatusBadRequest)
		return
	}

	// The proxy's own URLs never reach the upstream: a query value that is a
	// proxified URL (code cyrano did not rewrite read the real location and
	// passed it on) is replaced by the original. Every other byte of the
	// query is left as the browser sent it.
	target.RawQuery = urlrewrite.UnproxyQueryValues(target.RawQuery, h.opts.ProxyCfg)
	if target.Scheme == "http" && h.upgradeNavigation(w, r, target.Host) {
		return // tried over https first, as Chrome does (https_upgrades.go)
	}
	h.serveTarget(w, r, target)
}

// ServeHTTPWithTarget proxies r to an explicitly provided target URL without
// requiring a /cyrano/ path. Used for Referer-based routing of bare-path
// requests (e.g. webpack chunks, Cloudflare challenge scripts) that are
// relative to a proxied page's origin.
func (h *Handler) ServeHTTPWithTarget(w http.ResponseWriter, r *http.Request, target *url.URL) {
	h.serveTarget(w, r, target)
}

// serveTarget runs the httputil.ReverseProxy for an already-resolved target.
func (h *Handler) serveTarget(w http.ResponseWriter, r *http.Request, target *url.URL) {
	// Cloudflare Privacy Access Token (PAT) probes (/cdn-cgi/challenge-platform/
	// h/b/pat/) are forwarded to the upstream unchanged. PAT (RFC 9577) tokens
	// are origin-bound and require device attestation the proxy can't satisfy,
	// so the browser can't redeem the resulting challenge — but forwarding hands
	// the browser the EXACT response a direct browser sees (a real 401 with
	// WWW-Authenticate: PrivateToken), which desktop Chrome ignores before
	// falling back to Turnstile. Previously we fabricated a bare 401 with no
	// WWW-Authenticate to save the round-trip; that's a response no direct
	// browser ever produces, and in a clean session it was the one request that
	// stood out as failing — so we now let it through to match direct behavior.
	rp := &httputil.ReverseProxy{
		Director:       h.makeDirector(target),
		ModifyResponse: h.modifyResponse,
		Transport:      h.transport,
		ErrorHandler:   h.errorHandler(target, r),
		// Flush every write straight to the client. cyrano serves the browser
		// over HTTP/1.1 (plain localhost), so the browser has only ~6 connections
		// per origin. A streaming or long-lived upstream response (SSE, a
		// long-poll, x.com's real-time pipeline) that we buffer instead of flush
		// holds its connection open and never delivers, exhausting that pool —
		// every subsequent request then shows "pending" forever. -1 disables
		// buffering so streamed bytes reach the browser (and the request
		// completes) as they arrive. Rewritten bodies are already fully buffered
		// in ModifyResponse, so per-write flushing costs them nothing.
		FlushInterval: -1,
		// httputil.ReverseProxy default Director adds X-Forwarded-For; we
		// strip ours explicitly via dropOnRequest in makeDirector and let it
		// re-add a fresh one if needed.
	}
	rp.ServeHTTP(w, r)
}

// makeDirector returns a Director closure that mutates the outgoing request
// in place. ReverseProxy invokes this once per request before dispatching.
func (h *Handler) makeDirector(target *url.URL) func(*http.Request) {
	return func(req *http.Request) {
		req.URL.Scheme = target.Scheme
		req.URL.Host = target.Host
		req.URL.Path = target.Path
		req.URL.RawPath = target.RawPath
		req.URL.RawQuery = target.RawQuery
		req.URL.ForceQuery = target.ForceQuery
		// RawPath holds the target's path byte for byte ("/100%.jpg"
		// included); the upstream transport puts exactly that on the wire
		// (upstream.RoundTripper), leaving req.URL itself an ordinary URL.
		req.Host = target.Host

		for _, h := range dropOnRequest {
			req.Header.Del(h)
		}

		// Extract session ID BEFORE we modify the Cookie header. The session
		// cookie (crnsct) is a proxy-internal cookie — it won't have the
		// site-namespace prefix, so it's naturally excluded from forwarding.
		var sessionID string
		if h.opts.CookieJar != nil && h.opts.SessionCookieName != "" {
			if c, err := req.Cookie(h.opts.SessionCookieName); err == nil {
				sessionID = c.Value
			}
			// Stash for ModifyResponse via context — Director can't return a value.
			// Also expose it to the upstream RoundTripper (upstream.SessionKey)
			// so it scopes the connection pool to this session — connections are
			// reused within the session but never shared across sessions.
			ctx := context.WithValue(req.Context(), SessionContextKey{}, sessionID)
			ctx = context.WithValue(ctx, upstream.SessionKey{}, sessionID)
			*req = *req.WithContext(ctx)
		}

		if h.opts.Logger.Enabled(req.Context(), slog.LevelDebug) {
			*req = *req.WithContext(context.WithValue(req.Context(), upstream.ConnInfoKey{}, &upstream.ConnInfo{}))
		}

		// The cookies a direct browser would send this request (cookies.go).
		h.upstreamCookies(req, target, sessionID)

		// Advertise the same encodings a real browser sends. "gzip only" is a
		// trivial bot fingerprint that WAFs (Akamai, Cloudflare, etc.) key on,
		// so forward the browser's Accept-Encoding verbatim (Chrome sends
		// "gzip, deflate, br, zstd"). readDecompressedBody decodes gzip, br, and
		// zstd; the fallback below matches Chrome for the rare empty-header case.
		if req.Header.Get("Accept-Encoding") == "" {
			req.Header.Set("Accept-Encoding", "gzip, deflate, br, zstd")
		}

		// Referer, Origin and Sec-Fetch-Site as a direct browser would send
		// them (spec/Referrer.agda). The browser computed its own against the
		// proxy origin, where every page and resource is same-origin, so they
		// are recomputed here from the original URLs and the referring page's
		// own Referrer-Policy.
		noDictionaryOffer(req)
		h.filterClientHints(req, target, sessionID) // reads the proxied Referer: before it is replaced
		h.storageAccess(req, target, sessionID)     // reads the proxied Referer and the runtime's headers
		h.directFetchHeaders(req, target)
		ensurePriority(req, target, req.ProtoMajor < 2)

		// User-Agent isn't auto-set if the request had none and the Director
		// cleared it; keep whatever the client sent (or nothing).
		if _, ok := req.Header["User-Agent"]; !ok {
			req.Header.Set("User-Agent", "")
		}

		// Suppress httputil.ReverseProxy's automatic X-Forwarded-For injection.
		// ReverseProxy checks for a nil map value (Go issue #38079) and skips
		// the header when it's nil — setting to nil here is the documented way
		// to opt out.  A 127.0.0.1 XFF would expose the proxy to WAFs.
		req.Header["X-Forwarded-For"] = nil
	}
}

// modifyResponse runs after the upstream response headers arrive and before
// they're flushed to the client. We strip headers that would otherwise lock
// the browser into the original origin's security policies, then hand off
// to the BodyRewriter (if configured) for content transformation.
func (h *Handler) modifyResponse(resp *http.Response) error {
	h.restartForCriticalCH(resp) // may replace resp with a second response
	sessionID, _ := resp.Request.Context().Value(SessionContextKey{}).(string)
	upgradeLoaded(resp, sessionID)
	// Whatever is changed below, scripts still read what the origin sent.
	sent := resp.Header.Clone()
	defer func() { carryOriginalHeaders(resp.Header, sent) }()
	if err := h.translateResponse(resp); err != nil {
		return rewriteError{err}
	}
	return nil
}

// rewriteError marks a failure of the proxy's own processing of a response
// the origin did send — not a failure to reach the origin.
type rewriteError struct{ error }

func (e rewriteError) Unwrap() error { return e.error }

func (h *Handler) translateResponse(resp *http.Response) error {
	translatePermissionsPolicy(resp.Header)
	if resp.Header.Get("Alt-Svc") != "" {
		resp.Header.Set("Alt-Svc", "clear")
	}
	for _, name := range hopByHopHeaders {
		resp.Header.Del(name)
	}
	// Rewrite CSP headers: strip nonces (they have no isolation value in a
	// proxy context) and inject our proxy origin into every *-src source list
	// so rewritten resource URLs (which go through the proxy) can load.
	var proxyOrigin string
	if h.opts.ProxyCfg.PublicURL != nil {
		proxyOrigin = h.opts.ProxyCfg.PublicURL.Scheme + "://" + h.opts.ProxyCfg.PublicURL.Host
	}
	// Framing restrictions are judged here, against the real embedder
	// (frame_ancestors.go), before the policy is translated.
	if t := proxyTargetOf(resp); t != nil {
		judgeFraming(resp, t)
	}
	for _, name := range []string{"Content-Security-Policy", "Content-Security-Policy-Report-Only"} {
		vals := resp.Header.Values(name)
		if len(vals) == 0 {
			continue
		}
		resp.Header.Del(name)
		for _, v := range vals {
			resp.Header.Add(name, rewriteCSP(v, proxyOrigin))
		}
	}
	// Rewrite redirect targets so the browser follows them THROUGH the proxy.
	// Without this, a `302 Location: https://example.com/foo` from upstream
	// gets passed through verbatim and the browser navigates straight to the
	// origin, escaping URL containment entirely. We rewrite both Location
	// (the redirect target) and Content-Location (alternate URL for the
	// returned representation) the same way.
	if h.opts.ProxyCfg.PublicURL != nil && resp.Request != nil && resp.Request.URL != nil {
		rewriteRedirectHeader(resp, "Location", h.opts.ProxyCfg)
		rewriteRedirectHeader(resp, "Content-Location", h.opts.ProxyCfg)
		// Link (preload/modulepreload/prefetch hints) and Refresh carry URLs
		// the browser fetches or navigates to on its own.
		if vs := resp.Header.Values("Link"); len(vs) > 0 {
			resp.Header.Del("Link")
			for _, v := range vs {
				resp.Header.Add("Link", urlrewrite.RewriteLinkHeader(v, resp.Request.URL, h.opts.ProxyCfg))
			}
		}
		if v := resp.Header.Get("Refresh"); v != "" {
			resp.Header.Set("Refresh", urlrewrite.RewriteRefresh(v, resp.Request.URL, h.opts.ProxyCfg))
		}
		h.logExchange(resp) // before the Set-Cookie headers are replaced
		h.routeSetCookies(resp)
	}
	if resp.Request != nil && resp.Request.URL != nil {
		recordPagePolicy(resp, resp.Request.URL)
		noDictionaryRegistration(resp)
		sid, _ := resp.Request.Context().Value(SessionContextKey{}).(string)
		recordAcceptCH(resp, resp.Request.URL, sid)
	}
	if h.opts.BodyRewriter != nil && resp.Request != nil && resp.Request.URL != nil {
		// Director copied the upstream URL into resp.Request.URL — it's
		// the page's original URL, exactly what rewriters need as base.
		if err := h.opts.BodyRewriter(resp, resp.Request.URL); err != nil {
			return err
		}
	}
	return nil
}

// rewriteRedirectHeader runs urlrewrite.Rewrite over the named header value,
// using the upstream request URL as the base for relative-URL resolution.
// No-op when the header is absent or empty.
func rewriteRedirectHeader(resp *http.Response, name string, cfg urlrewrite.ProxyConfig) {
	v := resp.Header.Get(name)
	if v == "" {
		return
	}
	rewritten := urlrewrite.Rewrite(v, resp.Request.URL, cfg)
	if rewritten != v {
		resp.Header.Set(name, rewritten)
	}
}

// errorHandler turns transport errors into a 502 with a useful body and
// logs the upstream URL so we can debug from the proxy logs.
func (h *Handler) errorHandler(target *url.URL, inbound *http.Request) func(http.ResponseWriter, *http.Request, error) {
	return func(w http.ResponseWriter, _ *http.Request, err error) {
		// Connection-reset and timeout are the common failure modes — log
		// them at warn so we don't drown debugging signal in noise.
		level := slog.LevelWarn
		if errors.Is(err, http.ErrAbortHandler) {
			level = slog.LevelError
		}
		h.opts.Logger.LogAttrs(context.Background(), level, "upstream error",
			slog.String("target", target.String()),
			slog.String("err", err.Error()),
		)
		var re rewriteError
		if errors.As(err, &re) {
			// The proxy's own failure: say so.
			http.Error(w, "bad gateway", http.StatusBadGateway)
			return
		}
		// An upgraded navigation whose https load failed falls back to
		// http, as Chrome's does (https_upgrades.go).
		if target.Scheme == "https" && h.upgradeFailed(w, inbound, target.Host) {
			return
		}
		// A navigation that cannot reach its origin gets the browser's
		// error page direct; here, one saying why (no page script sees it).
		if inbound.Header.Get("Sec-Fetch-Mode") == "navigate" {
			h.navigationError(w, inbound, target, err)
			return
		}
		// The origin could not be reached (no such host, refused, reset, TLS
		// failure, cancelled). A browser going there directly gets no
		// response at all — fetch rejects, an image fails — so the page gets
		// none either: the connection is closed without one. (A 502 would be
		// a response, and fetch would resolve with it.)
		panic(http.ErrAbortHandler)
	}
}

// IsLoadRequest reports whether r is one we should route through the proxy
// pipeline (as opposed to a static-asset hit on the same path).
func IsLoadRequest(r *http.Request) bool {
	return strings.HasPrefix(r.URL.Path, "/cyrano/")
}

// logExchange records, at debug level, what went upstream and what came
// back: status, the names of the cookies sent and set (never their values),
// and the fetch metadata. For following a flow such as a challenge.
func (h *Handler) logExchange(resp *http.Response) {
	if !h.opts.Logger.Enabled(context.Background(), slog.LevelDebug) {
		return
	}
	names := func(vs []string, sep string) string {
		var out []string
		for _, v := range vs {
			for _, part := range strings.Split(v, sep) {
				if name, _, ok := strings.Cut(strings.TrimSpace(part), "="); ok && name != "" {
					out = append(out, name)
				}
				if sep == "\x00" {
					break
				}
			}
		}
		return strings.Join(out, ",")
	}
	var set []string
	for _, v := range resp.Header.Values("Set-Cookie") {
		name, rest, _ := strings.Cut(v, "=")
		attrs := ""
		if i := strings.Index(rest, ";"); i >= 0 {
			attrs = rest[i:]
		}
		set = append(set, strings.TrimSpace(name)+attrs)
	}
	r := resp.Request
	h.opts.Logger.LogAttrs(context.Background(), slog.LevelDebug, "exchange",
		slog.String("method", r.Method), slog.String("target", r.URL.Scheme+"://"+r.URL.Host+r.URL.Path),
		slog.Int("status", resp.StatusCode),
		slog.String("sent_cookies", names(r.Header.Values("Cookie"), ";")),
		slog.String("set_cookies", strings.Join(set, " | ")),
		slog.String("dest", r.Header.Get("Sec-Fetch-Dest")), slog.String("site", r.Header.Get("Sec-Fetch-Site")),
		slog.String("referer", r.Header.Get("Referer")), slog.String("origin", r.Header.Get("Origin")),
		slog.String("mitigated", resp.Header.Get("Cf-Mitigated")),
		slog.String("clearance_sent", tag(cookieValue(r.Header.Values("Cookie"), "cf_clearance"))),
		slog.String("clearance_set", tag(setCookieValue(resp.Header.Values("Set-Cookie"), "cf_clearance"))),
		slog.String("conn", connTag(r)),
		slog.String("hints", hintNamesOf(r.Header)),
		slog.String("sent", headerSummary(r.Header)))
}

// headerSummary lists the request headers sent upstream, sorted, values cut
// short and cookies left out: for comparing with a direct browser's.
func headerSummary(h http.Header) string {
	var out []string
	for name, vals := range h {
		if name == "Cookie" || len(vals) == 0 {
			continue
		}
		v := strings.Join(vals, ", ")
		if len(v) > 70 {
			v = v[:70] + "…"
		}
		out = append(out, strings.ToLower(name)+"="+v)
	}
	sort.Strings(out)
	return strings.Join(out, " | ")
}

// tag is a short fingerprint of a secret value, for comparing in logs.
func tag(v string) string {
	if v == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(v))
	return fmt.Sprintf("%x/%d", sum[:4], len(v))
}

func cookieValue(headers []string, name string) string {
	for _, h := range headers {
		for _, part := range strings.Split(h, ";") {
			if n, v, ok := strings.Cut(strings.TrimSpace(part), "="); ok && n == name {
				return v
			}
		}
	}
	return ""
}

func setCookieValue(headers []string, name string) string {
	for _, h := range headers {
		first, _, _ := strings.Cut(h, ";")
		if n, v, ok := strings.Cut(strings.TrimSpace(first), "="); ok && n == name {
			return v
		}
	}
	return ""
}

func connTag(r *http.Request) string {
	info, ok := r.Context().Value(upstream.ConnInfoKey{}).(*upstream.ConnInfo)
	if !ok || info.Local == "" {
		return ""
	}
	host, _, _ := net.SplitHostPort(info.Local)
	return fmt.Sprintf("local=%s reused=%v remote=%s", tag(host), info.Reused, info.Remote)
}

func hintNamesOf(h http.Header) string {
	var out []string
	for name := range h {
		if l := strings.ToLower(name); isHint(l) {
			out = append(out, strings.TrimPrefix(l, "sec-ch-"))
		}
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}

// proxyTargetOf is the upstream URL a response answers.
func proxyTargetOf(resp *http.Response) *url.URL {
	if resp.Request == nil {
		return nil
	}
	return resp.Request.URL
}
