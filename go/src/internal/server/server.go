// Package server wires the per-request pipeline: vhost lookup → static
// handler → upstream proxy. Phase 2 adds pass-through proxying via the
// proxy package; phase 3 will pipe the response through the rewriters.
package server

import (
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/yovico/cyrano/internal/config"
	"github.com/yovico/cyrano/internal/proxy"
	"github.com/yovico/cyrano/internal/static"
	"github.com/yovico/cyrano/internal/upstream"
	"github.com/yovico/cyrano/internal/urlrewrite"
	"github.com/yovico/cyrano/internal/wsproxy"
)

// Server holds the parsed config and the assets root.
type Server struct {
	Config     *config.File
	AssetsRoot string // absolute path to <repo>/go/assets
	Logger     *slog.Logger
	Prettify   bool // format JS and CSS responses for readability (debug only)
}

// New constructs a Server with sensible defaults applied.
func New(cfg *config.File, assetsRoot string, logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	abs, err := filepath.Abs(assetsRoot)
	if err == nil {
		assetsRoot = abs
	}
	return &Server{Config: cfg, AssetsRoot: assetsRoot, Logger: logger}
}

// proxyEndpoints derives the URL-rewriter ProxyConfig from a vhost — i.e.
// proxyEndpoints returns the ProxyConfig for the given vhost. The public URL
// is taken directly from vhost.PublicURL (CYRANO_PUBLIC_URL) when set;
// otherwise it is derived from the listen ports and TLS flags for backwards
// compatibility with deployments that don't set CYRANO_PUBLIC_URL.
func (s *Server) proxyEndpoints(vhost *config.VHost) urlrewrite.ProxyConfig {
	if vhost.PublicURL != "" {
		u, err := url.Parse(vhost.PublicURL)
		if err == nil && u.Scheme != "" && u.Host != "" {
			return urlrewrite.ProxyConfig{PublicURL: u}
		}
		s.Logger.Warn("CYRANO_PUBLIC_URL is invalid, falling back to derived URL",
			"value", vhost.PublicURL, "err", err)
	}

	// Fallback: derive from TLS flags and port numbers.
	domain := "localhost"
	if len(vhost.Hostnames) > 0 {
		domain = vhost.Hostnames[0]
	}

	httpsAvailable := false
	for _, srv := range s.Config.Servers {
		if srv.HTTPSEnabled {
			httpsAvailable = true
			break
		}
	}

	scheme := "http"
	port := strconv.Itoa(vhost.HTTPPort)
	if vhost.HTTPPort == 0 {
		port = "80"
	}
	if httpsAvailable {
		scheme = "https"
		port = strconv.Itoa(vhost.HTTPSPort)
		if vhost.HTTPSPort == 0 {
			port = "443"
		}
	}

	return urlrewrite.ProxyConfig{PublicURL: &url.URL{
		Scheme: scheme,
		Host:   domain + ":" + port,
	}}
}

// Handler returns the http.Handler for one listening port. The same handler
// is used for every server in cfg.Servers; vhost selection happens per-request
// via the Host header.
//
// We intentionally do NOT use http.ServeMux here. ServeMux calls path.Clean on
// every incoming path, which collapses `//` to `/`. Upstream URLs that contain
// embedded URLs in their paths (e.g. Cloudflare Image Resizing:
// /cdn-cgi/image/<opts>/https://origin.com/img.jpg) get routed through the
// proxy as /cyrano/https/host/cdn-cgi/image/<opts>/https://origin.com/img.jpg.
// The `://` within the path confuses path.Clean into stripping one slash,
// producing https:/origin.com — breaking the embedded URL. Using a plain
// HandlerFunc bypasses that redirect entirely.
func (s *Server) Handler() http.Handler {
	// One jar per server lifetime — shared across all requests so cookies
	// set on response N are available to forward on request N+1.
	jar := proxy.NewSessionJar()

	// One upstream transport per server lifetime, shared across all requests
	// and all per-request proxy.Handler instances. This is what makes HTTP/2
	// connection reuse possible: the transport keys its connection pool by
	// session, so a session's requests multiplex over its own connections
	// instead of dialing a fresh one each time. Constructing a transport
	// per request (as this code used to, implicitly, via proxy.New) discards
	// the pool every request — a connection storm that stalls fan-out-heavy
	// sites (x.com) behind the upstream edge's per-connection limits.
	transport := upstream.NewRoundTripper(false)

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Internal status endpoints checked before vhost lookup.
		switch r.URL.Path {
		case "/rewriter-status.json":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"status":"ok"}`))
			return
		case "/rewriter-extended-status.json":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"application":"ok","storage":"unimplemented"}`))
			return
		}

		vhost := s.Config.FindVHost(r.Host)
		if vhost == nil {
			s.Logger.Warn("no vhost for host", "host", r.Host)
			http.Error(w, "no vhost configured for this Host header", http.StatusBadRequest)
			return
		}

		// WebSocket upgrade? Goes through the wsproxy path — it hijacks
		// the conn and pipes raw frames after rewriting the handshake.
		if wsproxy.IsWSUpgrade(r) {
			wsHandler := wsproxy.New(wsproxy.Options{
				Logger: s.Logger.With("component", "wsproxy"),
			})
			wsHandler.ServeHTTP(w, r)
			return
		}

		// Construct the static handler once — used for the RewriterJSPath
		// short-circuit below AND the final fallback at the bottom.
		sh := &static.Handler{
			Root:           s.AssetsRoot,
			RewriterJSPath: vhost.RewriterJSPath,
			IsWebProxy:     vhost.Mode == "webproxy",
		}

		// Per-page state endpoints — wired into every rewritten page by
		// the HTML rewriter's bootstrap script chain.
		// RewriterJSPath is also handled here to prevent Referer-based routing
		// from accidentally proxying it to the upstream origin when the browser
		// includes a Referer pointing at a proxied page (e.g. hard reload).
		switch r.URL.Path {
		case vhost.HeadInjectionPath:
			headInjectionHandler(vhost).ServeHTTP(w, r)
			return
		case vhost.CookiesJSONPath:
			cookiesJSONHandler(vhost).ServeHTTP(w, r)
			return
		case vhost.RewriterJSPath:
			sh.ServeHTTP(w, r)
			return
		}

		// Browsers auto-fetch /favicon.ico on every navigation. We silence it
		// here before Referer routing can forward it upstream (which would
		// surface as a 404 in the browser console for every proxied page).
		if r.URL.Path == "/favicon.ico" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		// Proxified URL? Decode and forward to upstream.
		if proxy.IsLoadRequest(r) {
			// One handler per vhost so the body-rewriter sees the right config.
			// Cheap to construct; no Redis or other heavy init yet.
			proxyLogger := s.Logger.With("component", "proxy")
			rewriterLogger := s.Logger.With("component", "rewriter")
			proxyCfg := s.proxyEndpoints(vhost)
			proxyHandler := proxy.New(proxy.Options{
				SkipTLSVerify:     false,
				Logger:            proxyLogger,
				BodyRewriter:      makeBodyRewriter(vhost, proxyCfg, rewriterLogger, jar, vhost.SecretCookieName, s.Prettify),
				ProxyCfg:          proxyCfg,
				CookieJar:         jar,
				SessionCookieName: vhost.SecretCookieName,
				Transport:         transport,
			})
			proxyHandler.ServeHTTP(w, r)
			return
		}

		// Referer-based routing: bare-path requests from rewritten pages.
		// Redirect to the canonical /cyrano/<scheme>/<host><path> URL so the
		// browser's address bar stays correct and client-side routing works.
		proxyCfgForReferer := s.proxyEndpoints(vhost)
		if origin := inferOriginFromReferer(r, proxyCfgForReferer.PublicURL); origin != nil {
			escapedPath := r.URL.EscapedPath()
			if escapedPath == "" {
				escapedPath = "/"
			}
			dest := proxyCfgForReferer.PublicURL.String() +
				"/cyrano/" + origin.Scheme + "/" + origin.Host + escapedPath
			if r.URL.RawQuery != "" {
				dest += "?" + r.URL.RawQuery
			}
			// 307 (not 302) so POST method and body are preserved when
			// challenge scripts redirect their API calls through here.
			http.Redirect(w, r, dest, http.StatusTemporaryRedirect)
			return
		}

		// Cloudflare challenge-platform requests from blob workers or
		// about:blank sandboxes have no usable Referer. If the session cookie
		// is present and we recorded a challenge origin for this session,
		// proxy the request directly to that origin.
		if isChallengeplatformPath(r.URL.Path) {
			proxyCfgForChallenge := s.proxyEndpoints(vhost)
			proxyLogger := s.Logger.With("component", "proxy")
			rewriterLogger := s.Logger.With("component", "rewriter")
			challengeProxyHandler := proxy.New(proxy.Options{
				SkipTLSVerify:     false,
				Logger:            proxyLogger,
				BodyRewriter:      makeBodyRewriter(vhost, proxyCfgForChallenge, rewriterLogger, jar, vhost.SecretCookieName, s.Prettify),
				ProxyCfg:          proxyCfgForChallenge,
				CookieJar:         jar,
				SessionCookieName: vhost.SecretCookieName,
				Transport:         transport,
			})
			if scheme, host, ok := challengeOriginFromSession(r, jar, vhost.SecretCookieName); ok {
				target := &url.URL{
					Scheme:   scheme,
					Host:     host,
					Path:     r.URL.Path,
					RawQuery: r.URL.RawQuery,
				}
				s.Logger.Debug("challenge: routing via session origin",
					"path", r.URL.Path, "target", target.String())
				challengeProxyHandler.ServeHTTPWithTarget(w, r, target)
				return
			}
			// No session origin — fall through to empty-200 for .js files (legacy
			// fallback for about:blank sandboxes that predate session tracking).
			if isChallengeJSPath(r.URL.Path) {
				w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
				w.WriteHeader(http.StatusOK)
				return
			}
		}

		// Static / landing page / rewriter.js bundle (fallback).
		sh.ServeHTTP(w, r)
	})

	return logRequests(s.Logger, inner)
}

// ListenAndServe starts every server in s.Config.Servers. Returns the first
// error that aborts a listener.
func (s *Server) ListenAndServe() error {
	handler := s.Handler()
	errs := make(chan error, len(s.Config.Servers))
	for _, srv := range s.Config.Servers {
		go func() {
			addr := fmt.Sprintf(":%d", srv.Port)
			s.Logger.Info("listening", "addr", addr, "https", srv.HTTPSEnabled)
			if srv.HTTPSEnabled {
				if srv.SSLCert == "" || srv.SSLKey == "" {
					errs <- fmt.Errorf("server :%d: httpsEnabled but no sslCert/sslKey", srv.Port)
					return
				}
				errs <- http.ListenAndServeTLS(addr, srv.SSLCert, srv.SSLKey, handler)
			} else {
				errs <- http.ListenAndServe(addr, handler)
			}
		}()
	}
	return <-errs
}

// inferOriginFromReferer returns the scheme+host of the proxied page that
// sent this request, as inferred from the Referer header. Returns nil when:
//   - Referer is absent or unparseable
//   - Referer host doesn't match publicURL (not from this proxy)
//   - Referer has no /cyrano/ path, or it can't be parsed
//   - The decoded target scheme is not http or https
//
// Only called for requests that didn't match any known proxy route, so it
// enables transparent forwarding of bare-path resources (webpack chunks,
// Cloudflare /cdn-cgi/ scripts, etc.) to the right upstream.
func inferOriginFromReferer(r *http.Request, publicURL *url.URL) *url.URL {
	referer := r.Header.Get("Referer")
	if referer == "" {
		return nil
	}
	ref, err := url.Parse(referer)
	if err != nil {
		return nil
	}
	if !strings.EqualFold(ref.Host, publicURL.Host) {
		return nil
	}
	target, ok := urlrewrite.ParseCyranoPath(ref.Path, ref.RawQuery)
	if !ok {
		return nil
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil
	}
	return &url.URL{Scheme: target.Scheme, Host: target.Host}
}

// isChallengeplatformPath reports whether the path is a Cloudflare
// challenge-platform path that should be routed via session-based origin
// lookup when no Referer is available.
func isChallengeplatformPath(path string) bool {
	return strings.Contains(strings.ToLower(path), "/cdn-cgi/challenge-platform/")
}

// challengeOriginFromSession extracts the session ID from r's cookies and
// looks up the challenge origin stored by StoreChallengeOrigin. Returns the
// scheme and host when found, (_, _, false) otherwise.
func challengeOriginFromSession(r *http.Request, jar *proxy.SessionJar, sessName string) (string, string, bool) {
	if jar == nil || sessName == "" {
		return "", "", false
	}
	c, err := r.Cookie(sessName)
	if err != nil {
		return "", "", false
	}
	return jar.ChallengeOrigin(c.Value)
}

// logRequests is a tiny middleware that emits one slog line per request.
func logRequests(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
		logger.Info("req", "method", r.Method, "path", r.URL.Path, "host", r.Host)
	})
}
