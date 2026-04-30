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

	"github.com/yovico/cyrano/internal/b64u"
	"github.com/yovico/cyrano/internal/config"
	"github.com/yovico/cyrano/internal/proxy"
	"github.com/yovico/cyrano/internal/static"
	"github.com/yovico/cyrano/internal/urlrewrite"
	"github.com/yovico/cyrano/internal/wsproxy"
)

// Server holds the parsed config and the assets root.
type Server struct {
	Config     *config.File
	AssetsRoot string // absolute path to <repo>/go/assets
	Logger     *slog.Logger
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
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/rewriter-status.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/rewriter-extended-status.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"application":"ok","storage":"unimplemented"}`))
	})

	// Per-request dispatch: pick vhost, fall through to static handler when
	// the request isn't a proxified URL.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
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
				SkipTLSVerify: false,
				Logger:        proxyLogger,
				BodyRewriter:  makeBodyRewriter(vhost, proxyCfg, rewriterLogger),
				ProxyCfg:      proxyCfg,
			})
			proxyHandler.ServeHTTP(w, r)
			return
		}

		// Referer-based routing: bare-path requests from rewritten pages.
		// Handles webpack chunks, Cloudflare challenge scripts, and any other
		// path-absolute resources loaded by JavaScript on a proxied page.
		proxyCfgForReferer := s.proxyEndpoints(vhost)
		if origin := inferOriginFromReferer(r, proxyCfgForReferer.PublicURL); origin != nil {
			target := &url.URL{
				Scheme:   origin.Scheme,
				Host:     origin.Host,
				Path:     r.URL.Path,
				RawPath:  r.URL.RawPath,
				RawQuery: r.URL.RawQuery,
			}
			proxyLogger := s.Logger.With("component", "proxy")
			rewriterLogger := s.Logger.With("component", "rewriter")
			proxyHandler := proxy.New(proxy.Options{
				SkipTLSVerify: false,
				Logger:        proxyLogger,
				BodyRewriter:  makeBodyRewriter(vhost, proxyCfgForReferer, rewriterLogger),
				ProxyCfg:      proxyCfgForReferer,
			})
			proxyHandler.ServeHTTPWithTarget(w, r, target)
			return
		}

		// Static / landing page / rewriter.js bundle (fallback).
		sh.ServeHTTP(w, r)
	})

	return logRequests(s.Logger, mux)
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
//   - Referer has no ?goto= parameter, or the parameter can't be decoded
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
	loadParam := ref.Query().Get("goto")
	if loadParam == "" {
		return nil
	}
	targetStr, err := b64u.Decode(loadParam)
	if err != nil {
		return nil
	}
	target, err := url.Parse(targetStr)
	if err != nil || target == nil {
		return nil
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil
	}
	return &url.URL{Scheme: target.Scheme, Host: target.Host}
}

// logRequests is a tiny middleware that emits one slog line per request.
func logRequests(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
		logger.Info("req", "method", r.Method, "path", r.URL.Path, "host", r.Host)
	})
}
