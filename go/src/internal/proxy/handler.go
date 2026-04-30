// Package proxy is the upstream-fetch leg of the rewriter pipeline. It
// decodes the URL-containment scheme (`?goto=<b64>`), opens a connection to
// the original host, and streams the response back to the client.
//
// Phase 2 only: pass-through. No body rewriting happens here yet — that
// belongs to a wrapper handler in phase 3 that pipes the response through
// the HTML/JS/CSS rewriters before flushing it to the client.
package proxy

import (
	"context"
	"crypto/tls"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/yovico/cyrano/internal/b64u"
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
	// rewriters). The target URL — the decoded ?goto= value — is the
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
}

// Handler decodes ?goto= and proxies. It implements http.Handler so it can
// be mounted into an http.ServeMux directly.
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
	t := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ResponseHeaderTimeout: opts.Timeout,
		ForceAttemptHTTP2:     true,
		// nosemgrep: gosec.G402.tls-unsafe-config — flagged off by config, dev-only.
		TLSClientConfig: &tls.Config{InsecureSkipVerify: opts.SkipTLSVerify},
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

// dangerousResponseHeaders are headers we strip from the upstream response
// because they'd lock the browser into the original origin's policies and
// break the rewriting (HSTS would force https on our proxy host; CSP would
// block our injected /rewriter.js; etc.).
var dangerousResponseHeaders = []string{
	"Strict-Transport-Security",
	"Content-Security-Policy",
	"Content-Security-Policy-Report-Only",
	"Public-Key-Pins",
	"Alt-Svc",
}

// dropOnRequest are headers we never forward upstream — they leak the proxy
// origin or carry session-scoped data we manage ourselves.
var dropOnRequest = []string{
	"X-Forwarded-For",
	"X-Forwarded-Proto",
	"X-Forwarded-Port",
	"X-Forwarded-Host",
}

// ServeHTTP routes one proxified request.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	loadParam := r.URL.Query().Get("goto")
	if loadParam == "" {
		http.Error(w, "missing goto= query param", http.StatusBadRequest)
		return
	}

	targetStr, err := b64u.Decode(loadParam)
	if err != nil {
		http.Error(w, "invalid goto= encoding", http.StatusBadRequest)
		return
	}
	target, err := url.Parse(targetStr)
	if err != nil || target == nil {
		http.Error(w, "invalid goto= URL", http.StatusBadRequest)
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

	// Merge any extra query params from the proxy URL (beyond "goto") into the
	// upstream target URL. Challenge flows (AWS WAF, Cloudflare) append params
	// like chal_t= and force_referer= to the proxy URL after the challenge
	// interstitial runs; these must reach the upstream server or the flow breaks.
	// We translate force_referer= from proxy URL back to the original page URL
	// so the upstream sees the correct referrer domain.
	if extraParams := extraQueryParams(r.URL.Query(), h.opts.ProxyCfg); len(extraParams) > 0 {
		q := target.Query()
		for k, vs := range extraParams {
			for _, v := range vs {
				q.Add(k, v)
			}
		}
		target.RawQuery = q.Encode()
	}

	h.serveTarget(w, r, target)
}

// ServeHTTPWithTarget proxies r to an explicitly provided target URL without
// requiring a ?goto= parameter. Used for Referer-based routing of bare-path
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
		// Forward cookies: JS on the proxied page stores cookies under the
		// proxy origin (e.g. aws-waf-token, cf_clearance after Set-Cookie
		// domain rewriting below). Passing them through lets bot-challenge
		// clearance cookies reach the upstream server.
		// Force gzip — keeps payloads small over the wire and the rewriter
		// will gunzip when it needs to inspect the body.
		req.Header.Set("Accept-Encoding", "gzip")

		// Translate proxy Referer → original page URL so CDN hotlink
		// protection sees the correct origin domain instead of localhost.
		// The browser sends "Referer: http://proxy/?goto=<b64(page)>"; we
		// decode that back to the original page URL before forwarding.
		var translatedRefOrigin string
		if ref := req.Header.Get("Referer"); ref != "" {
			if translated := h.translateReferer(ref); translated != "" {
				req.Header.Set("Referer", translated)
				if u, err := url.Parse(translated); err == nil {
					translatedRefOrigin = u.Scheme + "://" + u.Host
				}
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
	}
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
	gotoParam := u.Query().Get("goto")
	if gotoParam == "" {
		return ""
	}
	decoded, err := b64u.Decode(gotoParam)
	if err != nil {
		return ""
	}
	return decoded
}

// modifyResponse runs after the upstream response headers arrive and before
// they're flushed to the client. We strip headers that would otherwise lock
// the browser into the original origin's security policies, then hand off
// to the BodyRewriter (if configured) for content transformation.
func (h *Handler) modifyResponse(resp *http.Response) error {
	for _, name := range dangerousResponseHeaders {
		resp.Header.Del(name)
	}
	for _, name := range hopByHopHeaders {
		resp.Header.Del(name)
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
		// Rewrite Set-Cookie so the browser stores upstream cookies under the
		// proxy origin. Without this, cookies with Domain=.example.com are
		// silently rejected when the page is served from localhost:9081, and
		// clearance cookies (cf_clearance, aws-waf-token, etc.) are lost.
		rewriteSetCookies(resp, h.opts.ProxyCfg.PublicURL)
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

// rewriteSetCookies rewrites all Set-Cookie response headers so the browser
// accepts and stores them under the proxy origin instead of the upstream
// domain. Specifically:
//
//   - Domain= is replaced with the proxy host (or removed, which defaults to
//     the current host).
//   - Secure is dropped when the proxy is serving plain HTTP.
//   - SameSite=None is downgraded to SameSite=Lax when Secure is absent
//     (browsers require Secure for SameSite=None).
func rewriteSetCookies(resp *http.Response, publicURL *url.URL) {
	cookies := resp.Header["Set-Cookie"]
	if len(cookies) == 0 {
		return
	}
	isHTTPS := strings.EqualFold(publicURL.Scheme, "https")
	rewritten := make([]string, 0, len(cookies))
	for _, raw := range cookies {
		rewritten = append(rewritten, rewriteOneCookie(raw, isHTTPS))
	}
	resp.Header["Set-Cookie"] = rewritten
}

// rewriteOneCookie rewrites a single Set-Cookie header value.
func rewriteOneCookie(raw string, proxyIsHTTPS bool) string {
	// Split into name=value ; attr ; attr ... parts.
	parts := strings.Split(raw, ";")
	out := make([]string, 0, len(parts))
	out = append(out, strings.TrimSpace(parts[0])) // name=value always first
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

// extraQueryParams returns the query parameters from proxyQuery that are not
// the "goto" key, translating any "force_referer" value from a proxy URL back
// to the original upstream URL. Used to forward challenge-flow params (chal_t,
// force_referer) appended by AWS WAF / Cloudflare to the proxy URL.
func extraQueryParams(proxyQuery url.Values, cfg urlrewrite.ProxyConfig) url.Values {
	out := url.Values{}
	for k, vs := range proxyQuery {
		if k == "goto" {
			continue
		}
		for _, v := range vs {
			if k == "force_referer" && cfg.PublicURL != nil {
				// Translate proxy URL → upstream URL if it's our origin.
				if u, err := url.Parse(v); err == nil &&
					strings.EqualFold(u.Host, cfg.PublicURL.Host) {
					if gotoParam := u.Query().Get("goto"); gotoParam != "" {
						if decoded, err := b64u.Decode(gotoParam); err == nil {
							out.Add(k, decoded)
							continue
						}
					}
				}
			}
			out.Add(k, v)
		}
	}
	return out
}

// IsLoadRequest reports whether r is one we should route through the proxy
// pipeline (as opposed to a static-asset hit on the same path).
func IsLoadRequest(r *http.Request) bool {
	return r.URL.Query().Has("goto") &&
		!strings.HasPrefix(r.URL.Path, "/rewriter-")
}
