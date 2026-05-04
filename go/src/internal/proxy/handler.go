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
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/publicsuffix"

	"github.com/yovico/cyrano/internal/tlsdial"
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
}

// sessionKey is the context key used to pass the session ID from Director
// to ModifyResponse within a single request.
type sessionKey struct{}

// Handler decodes /cyrano/ paths and proxies. It implements http.Handler so it
// can be mounted into an http.ServeMux directly.
type Handler struct {
	opts      Options
	transport *http.Transport
}

// New constructs a Handler with sensible defaults applied.
func New(opts Options) *Handler {
	if opts.Timeout == 0 {
		opts.Timeout = 15 * time.Second
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	tcpDialer := &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	t := &http.Transport{
		DialContext:    tcpDialer.DialContext,
		DialTLSContext: tlsdial.NewDialTLSContext(tcpDialer, opts.SkipTLSVerify),
		// TLSClientConfig and TLSHandshakeTimeout are intentionally absent:
		// DialTLSContext owns TLS config and the handshake timeout.
		// ForceAttemptHTTP2 is omitted: tlsdial limits ALPN to http/1.1 so
		// servers never select h2 (see tlsdial package comment).
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       90 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ResponseHeaderTimeout: opts.Timeout,
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

// stripResponseHeaders are headers that cannot be reconstituted for the proxy
// context and must be stripped entirely:
//   - HSTS: proxy may serve HTTP; leaving this would force the browser to
//     require HTTPS for future connections to the proxy host.
//   - Public-Key-Pins: pinned cert is the origin's cert, not the proxy's.
//   - Alt-Svc: would route future requests over QUIC/H3 directly to the
//     origin, bypassing the proxy entirely.
//   - Permissions-Policy / Feature-Policy: allowlists name upstream origins
//     (e.g. "i.dell.com"), which the browser evaluates against the proxy
//     origin — making them a no-op at best and console-error noise at worst.
//     Many sites send pre-spec syntax with unquoted origins that browsers now
//     reject with warnings. There is no safe way to rewrite these for the
//     proxy context, so we drop them.
//
// Headers like CSP, X-Frame-Options, and Cross-Origin-* are NOT stripped.
// They use the `'self'` keyword, which the browser evaluates relative to the
// current page origin (the proxy origin). Our rewriter.js is served at
// /rewriter.js on the proxy origin, so it is covered by `'self'` in any
// script-src directive. Cross-Origin-* policies also work correctly because
// all proxied resources share the proxy origin.
var stripResponseHeaders = []string{
	"Strict-Transport-Security",
	"Public-Key-Pins",
	"Alt-Svc",
	"Permissions-Policy",
	"Feature-Policy",
}

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
	target, ok := urlrewrite.ParseCyranoPath(r.URL.Path, r.URL.RawQuery)
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

	// Translate any force_referer= proxy URL values back to original upstream URLs.
	// Challenge flows (AWS WAF, Cloudflare) append force_referer= to the proxy URL;
	// the upstream server expects the original page URL, not our proxy URL.
	if h.opts.ProxyCfg.PublicURL != nil {
		if q := target.Query(); q.Has("force_referer") {
			changed := false
			for i, v := range q["force_referer"] {
				if u, err := url.Parse(v); err == nil &&
					strings.EqualFold(u.Host, h.opts.ProxyCfg.PublicURL.Host) {
					if orig, ok := urlrewrite.ParseCyranoPath(u.Path, u.RawQuery); ok {
						q["force_referer"][i] = orig.String()
						changed = true
					}
				}
			}
			if changed {
				target.RawQuery = q.Encode()
			}
		}
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
	rp := &httputil.ReverseProxy{
		Director:       h.makeDirector(target),
		ModifyResponse: h.modifyResponse,
		Transport:      h.transport,
		ErrorHandler:   h.errorHandler(target),
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
			*req = *req.WithContext(
				context.WithValue(req.Context(), sessionKey{}, sessionID),
			)
		}

		// Forward only cookies that belong to this upstream. Cookies are stored
		// under the proxy origin with a site-namespace prefix (see cookiePrefixFor
		// and rewriteSetCookies). Filtering here prevents cross-site cookie
		// contamination — e.g. cf_clearance from a Cloudflare-protected site
		// leaking into a request to an Akamai-protected site where it looks
		// suspicious. The prefix is stripped before forwarding so the upstream
		// sees plain cookie names.
		if cookieHeader := req.Header.Get("Cookie"); cookieHeader != "" {
			prefix := cookiePrefixFor(target.Host)
			var forwarded []string
			for _, kv := range strings.Split(cookieHeader, ";") {
				kv = strings.TrimSpace(kv)
				if strings.HasPrefix(kv, prefix) {
					forwarded = append(forwarded, kv[len(prefix):])
				}
			}
			if len(forwarded) > 0 {
				req.Header.Set("Cookie", strings.Join(forwarded, "; "))
			} else {
				req.Header.Del("Cookie")
			}
		}

		// Inject server-side HttpOnly cookies from the jar. These were stored
		// here on a previous response instead of being forwarded to the browser.
		if h.opts.CookieJar != nil && sessionID != "" {
			jarCookies := h.opts.CookieJar.RetrieveForRequest(sessionID, target.Host, target.Path)
			if len(jarCookies) > 0 {
				parts := make([]string, len(jarCookies))
				for i, c := range jarCookies {
					parts[i] = c.Name + "=" + c.Value
				}
				extra := strings.Join(parts, "; ")
				if existing := req.Header.Get("Cookie"); existing != "" {
					req.Header.Set("Cookie", existing+"; "+extra)
				} else {
					req.Header.Set("Cookie", extra)
				}
			}
		}

		// Advertise the same encodings a real browser sends. "gzip only" is a
		// trivial bot fingerprint that WAFs (Akamai, Cloudflare, etc.) key on.
		// readDecompressedBody handles gzip and br; zstd is stripped here so
		// we don't receive an encoding we can't decompress yet.
		ae := req.Header.Get("Accept-Encoding")
		ae = removeEncoding(ae, "zstd")
		if ae == "" {
			ae = "gzip, deflate, br"
		}
		req.Header.Set("Accept-Encoding", ae)

		// Translate proxy Referer → original page URL so CDN hotlink
		// protection sees the correct origin domain instead of localhost.
		// The browser sends "Referer: http://proxy/cyrano/<scheme>/<host><path>"; we
		// decode that back to the original page URL before forwarding.
		var translatedRefOrigin string
		if ref := req.Header.Get("Referer"); ref != "" {
			if translated := h.translateReferer(ref); translated != "" {
				req.Header.Set("Referer", translated)
				if u, err := url.Parse(translated); err == nil {
					translatedRefOrigin = u.Scheme + "://" + u.Host
				}
			} else if h.isProxyReferer(ref) {
				// Referer is our proxy origin but has no /cyrano/ path
				// (e.g. the landing page on first navigation). Strip it so
				// the upstream doesn't see "Referer: http://localhost:9081/"
				// and block the request as a known proxy.
				req.Header.Del("Referer")
			}
		}

		// Translate proxy Origin → original page origin. The browser sends
		// "Origin: http://proxy" for cross-origin fetches made from our
		// proxied pages (e.g. bot-challenge chal_report POSTs). The upstream
		// server validates Origin and rejects requests with a wrong origin.
		if origin := req.Header.Get("Origin"); origin != "" && h.isProxyOrigin(origin) {
			if translatedRefOrigin != "" {
				req.Header.Set("Origin", translatedRefOrigin)
			} else {
				// No Referer to derive the origin from — use the target's origin.
				req.Header.Set("Origin", target.Scheme+"://"+target.Host)
			}
		}

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

// isProxyReferer reports whether the Referer header value points at our own
// proxy origin. Used to strip proxy-origin Referers that can't be translated
// before they reach the upstream and expose the proxy.
func (h *Handler) isProxyReferer(referer string) bool {
	if h.opts.ProxyCfg.PublicURL == nil {
		return false
	}
	u, err := url.Parse(referer)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, h.opts.ProxyCfg.PublicURL.Host)
}

// isProxyOrigin reports whether the given Origin header value is our own
// proxy origin (scheme://host). Used to decide when to translate the Origin.
func (h *Handler) isProxyOrigin(origin string) bool {
	if h.opts.ProxyCfg.PublicURL == nil {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, h.opts.ProxyCfg.PublicURL.Host)
}

// translateReferer decodes a proxy Referer header back to the original URL.
// Returns "" when the Referer isn't a proxy URL or can't be decoded.
func (h *Handler) translateReferer(referer string) string {
	if h.opts.ProxyCfg.PublicURL == nil {
		return ""
	}
	u, err := url.Parse(referer)
	if err != nil || !strings.EqualFold(u.Host, h.opts.ProxyCfg.PublicURL.Host) {
		return ""
	}
	target, ok := urlrewrite.ParseCyranoPath(u.Path, u.RawQuery)
	if !ok {
		return ""
	}
	return target.String()
}

// modifyResponse runs after the upstream response headers arrive and before
// they're flushed to the client. We strip headers that would otherwise lock
// the browser into the original origin's security policies, then hand off
// to the BodyRewriter (if configured) for content transformation.
func (h *Handler) modifyResponse(resp *http.Response) error {
	for _, name := range stripResponseHeaders {
		resp.Header.Del(name)
	}
	for _, name := range hopByHopHeaders {
		resp.Header.Del(name)
	}
	// Strip nonce tokens from CSP so our injected rewriter.js and bootstrap
	// script can load. Nonces serve no security purpose in the proxy context
	// (all frames are already same-origin); keeping them only blocks us.
	for _, name := range []string{"Content-Security-Policy", "Content-Security-Policy-Report-Only"} {
		vals := resp.Header.Values(name)
		if len(vals) == 0 {
			continue
		}
		resp.Header.Del(name)
		for _, v := range vals {
			resp.Header.Add(name, stripCSPNonces(v))
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
		h.routeSetCookies(resp)
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

// routeSetCookies splits Set-Cookie headers from the upstream response:
//   - HttpOnly cookies → stored in the session jar (never forwarded to browser)
//   - non-HttpOnly cookies → rewritten for the proxy origin and forwarded as usual
//
// When CookieJar is nil, all cookies go through the existing rewrite path.
// When a new session ID must be issued (first ever response for this client),
// a crnsct session cookie is appended to the response.
func (h *Handler) routeSetCookies(resp *http.Response) {
	if h.opts.CookieJar == nil {
		rewriteSetCookies(resp, h.opts.ProxyCfg.PublicURL, resp.Request.URL.Host)
		return
	}

	// Read the session ID that makeDirector stored in the request context.
	sessionID, _ := resp.Request.Context().Value(sessionKey{}).(string)
	newSession := sessionID == ""
	if newSession {
		sessionID = GenerateSessionID()
	}

	// Partition Set-Cookie headers.
	var forBrowser []string
	var forJar []*http.Cookie
	for _, raw := range resp.Header["Set-Cookie"] {
		c := ParseSetCookieHeader(raw)
		if c.HttpOnly {
			forJar = append(forJar, c)
		} else {
			forBrowser = append(forBrowser, raw)
		}
	}

	// Store HttpOnly cookies server-side.
	if len(forJar) > 0 {
		h.opts.CookieJar.StoreServerCookies(sessionID, resp.Request.URL.Host, forJar)
	}

	// Rewrite non-HttpOnly cookies for the proxy origin and forward to browser.
	if len(forBrowser) > 0 {
		resp.Header["Set-Cookie"] = forBrowser
		rewriteSetCookies(resp, h.opts.ProxyCfg.PublicURL, resp.Request.URL.Host)
	} else {
		resp.Header.Del("Set-Cookie")
	}

	// Issue (or refresh) the proxy session cookie. Added AFTER rewriteSetCookies
	// so it doesn't go through the upstream-cookie name-prefix rewrite.
	if newSession {
		isHTTPS := strings.EqualFold(h.opts.ProxyCfg.PublicURL.Scheme, "https")
		sc := &http.Cookie{
			Name:     h.opts.SessionCookieName,
			Value:    sessionID,
			Path:     "/",
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			Secure:   isHTTPS,
		}
		resp.Header.Add("Set-Cookie", sc.String())
	}
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

// cookieSiteKey returns a short stable key for the eTLD+1 of host, used as
// the cookie namespace prefix. e.g. "www.casio.com" → "casio_com".
func cookieSiteKey(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if etld1, err := publicsuffix.EffectiveTLDPlusOne(host); err == nil {
		return strings.ReplaceAll(etld1, ".", "_")
	}
	return strings.ReplaceAll(host, ".", "_")
}

// cookiePrefixFor returns the namespace prefix for cookies belonging to host.
// Cookies are stored with this prefix in the browser so that the Director can
// filter them back to only the originating site when forwarding requests,
// preventing cross-site cookie contamination (e.g. cf_clearance from site A
// being forwarded to site B's upstream).
func cookiePrefixFor(host string) string {
	return "__crn__" + cookieSiteKey(host) + "__"
}

// rewriteSetCookies rewrites all Set-Cookie response headers so the browser
// accepts and stores them under the proxy origin instead of the upstream
// domain. Specifically:
//
//   - Domain= is replaced with the proxy host (or removed, which defaults to
//     the current host).
//   - Secure is dropped when the proxy is serving plain HTTP.
//   - SameSite=None is downgraded to SameSite=Lax when Secure is absent
//     (browsers require Secure for SameSite=None).
func rewriteSetCookies(resp *http.Response, publicURL *url.URL, upstreamHost string) {
	cookies := resp.Header["Set-Cookie"]
	if len(cookies) == 0 {
		return
	}
	isHTTPS := strings.EqualFold(publicURL.Scheme, "https")
	prefix := cookiePrefixFor(upstreamHost)
	rewritten := make([]string, 0, len(cookies))
	for _, raw := range cookies {
		rewritten = append(rewritten, rewriteOneCookie(raw, isHTTPS, prefix))
	}
	resp.Header["Set-Cookie"] = rewritten
}

// rewriteOneCookie rewrites a single Set-Cookie header value, prefixing the
// cookie name with namePrefix so the browser stores it namespaced to the
// upstream site (see cookiePrefixFor). The Director strips the prefix when
// forwarding cookies back to the same upstream on subsequent requests.
func rewriteOneCookie(raw string, proxyIsHTTPS bool, namePrefix string) string {
	// Split into name=value ; attr ; attr ... parts.
	parts := strings.Split(raw, ";")
	out := make([]string, 0, len(parts))
	out = append(out, namePrefix+strings.TrimSpace(parts[0])) // prefix + name=value
	hasSecure := false
	for _, p := range parts[1:] {
		attr := strings.TrimSpace(p)
		lower := strings.ToLower(attr)
		if strings.HasPrefix(lower, "domain=") {
			// Drop the upstream domain — the browser will default to the
			// current host (our proxy), which is what we want.
			continue
		}
		if lower == "secure" {
			if proxyIsHTTPS {
				hasSecure = true
				out = append(out, attr)
			}
			// Drop Secure on HTTP proxy — browser would reject it.
			continue
		}
		if strings.HasPrefix(lower, "samesite=none") && !proxyIsHTTPS {
			// SameSite=None requires Secure; downgrade to Lax.
			out = append(out, "SameSite=Lax")
			continue
		}
		out = append(out, attr)
	}
	_ = hasSecure
	return strings.Join(out, "; ")
}

// errorHandler turns transport errors into a 502 with a useful body and
// logs the upstream URL so we can debug from the proxy logs.
func (h *Handler) errorHandler(target *url.URL) func(http.ResponseWriter, *http.Request, error) {
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
		http.Error(w, "bad gateway", http.StatusBadGateway)
	}
}

// IsLoadRequest reports whether r is one we should route through the proxy
// pipeline (as opposed to a static-asset hit on the same path).
func IsLoadRequest(r *http.Request) bool {
	return strings.HasPrefix(r.URL.Path, "/cyrano/")
}

// removeEncoding removes a named token from a comma-separated
// Accept-Encoding value (e.g. removes "zstd" from "gzip, deflate, br, zstd").
// Returns the original string if the token is not present.
func removeEncoding(ae, token string) string {
	parts := strings.Split(ae, ",")
	out := parts[:0]
	for _, p := range parts {
		// Each part may be "token" or "token;q=0.x" — trim both.
		name := strings.ToLower(strings.TrimSpace(strings.SplitN(p, ";", 2)[0]))
		if name == strings.ToLower(token) {
			continue
		}
		out = append(out, p)
	}
	if len(out) == len(parts) {
		return ae
	}
	return strings.TrimLeft(strings.Join(out, ","), " ,")
}
