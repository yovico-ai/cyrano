package server

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/yovico/cyrano/internal/config"
	"github.com/yovico/cyrano/internal/cssrewrite"
	"github.com/yovico/cyrano/internal/htmlrewrite"
	"github.com/yovico/cyrano/internal/jsrewrite"
	"github.com/yovico/cyrano/internal/urlrewrite"
)

// makeBodyRewriter assembles the proxy.Options.BodyRewriter function for
// the given vhost. Returned closure dispatches by Content-Type:
//
//   - text/html, application/xhtml+xml → htmlrewrite (with inline JS hook)
//   - application/javascript et al     → jsrewrite directly on the body
//   - everything else                  → pass through unchanged
//
// CSS and JSON rewriting land in phase 5.
//
// All errors are returned to the caller AND logged with target/content-type
// context — ReverseProxy turns the error into a 502 but the log gives us
// enough to diagnose without re-running.
func makeBodyRewriter(vhost *config.VHost, proxyCfg urlrewrite.ProxyConfig, logger *slog.Logger) func(*http.Response, *url.URL) error {
	clientPassthrough := buildClientPassthrough(vhost, proxyCfg)
	jsOpts := jsrewrite.DefaultOptions()
	jsOpts.Logger = logger.With("component", "jsrewrite")
	rewriteJS := func(src []byte) []byte { return jsrewrite.Rewrite(src, jsOpts) }

	cssLogger := logger.With("component", "cssrewrite")
	rewriteCSS := func(target *url.URL) func([]byte) []byte {
		return func(src []byte) []byte {
			return cssrewrite.Rewrite(src, cssrewrite.Options{
				BaseURL: target, Proxy: proxyCfg, Logger: cssLogger,
			})
		}
	}

	return func(resp *http.Response, target *url.URL) error {
		ct := resp.Header.Get("Content-Type")

		switch {
		case isCSS(resp):
			body, err := readDecompressedBody(resp)
			if err != nil {
				logger.Warn("rewriter: read upstream CSS body failed",
					"target", target.String(), "ct", ct, "err", err)
				return fmt.Errorf("read upstream body: %w", err)
			}
			rewritten := cssrewrite.Rewrite(body, cssrewrite.Options{
				BaseURL: target,
				Proxy:   proxyCfg,
				Logger:  cssLogger,
			})
			logger.Debug("rewriter: css rewritten",
				"target", target.String(), "in", len(body), "out", len(rewritten))
			replaceBody(resp, rewritten)

		case isHTML(resp):
			body, err := readDecompressedBody(resp)
			if err != nil {
				logger.Warn("rewriter: read upstream body failed",
					"target", target.String(), "ct", ct, "err", err)
				return fmt.Errorf("read upstream body: %w", err)
			}
			var out bytes.Buffer
			cfg := htmlrewrite.Config{
				BaseURL:           target,
				Proxy:             proxyCfg,
				RewriterJSPath:      vhost.RewriterJSPath,
				HeadInjectionPath: vhost.HeadInjectionPath,
				InjectBootstrap:   true,
				ClientPassthrough: clientPassthrough,
				RewriteInlineJS:   rewriteJS,
				RewriteInlineCSS:  rewriteCSS(target),
			}
			if err := htmlrewrite.Rewrite(&out, bytes.NewReader(body), cfg); err != nil {
				logger.Warn("rewriter: html rewrite failed",
					"target", target.String(), "size", len(body), "err", err)
				return fmt.Errorf("html rewrite: %w", err)
			}
			logger.Debug("rewriter: html rewritten",
				"target", target.String(), "in", len(body), "out", out.Len())
			replaceBody(resp, out.Bytes())

		case isJS(resp):
			body, err := readDecompressedBody(resp)
			if err != nil {
				logger.Warn("rewriter: read upstream JS body failed",
					"target", target.String(), "ct", ct, "err", err)
				return fmt.Errorf("read upstream body: %w", err)
			}
			rewritten := rewriteJS(body)
			logger.Debug("rewriter: js rewritten",
				"target", target.String(), "in", len(body), "out", len(rewritten),
				"identical", len(body) == len(rewritten))
			replaceBody(resp, rewritten)
		}
		return nil
	}
}

// replaceBody substitutes resp.Body with the given bytes, fixing
// Content-Length and dropping any incompatible Transfer-Encoding header.
func replaceBody(resp *http.Response, body []byte) {
	resp.Body = io.NopCloser(bytes.NewReader(body))
	resp.ContentLength = int64(len(body))
	resp.Header.Set("Content-Length", fmt.Sprintf("%d", len(body)))
	resp.Header.Del("Transfer-Encoding")
}

// isHTML reports whether the response Content-Type is rewritable HTML.
func isHTML(resp *http.Response) bool {
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	return strings.Contains(ct, "text/html") ||
		strings.Contains(ct, "application/xhtml+xml")
}

// isJS reports whether the response Content-Type is rewritable JavaScript.
// Covers all the `*/javascript` and `*/ecmascript` MIME variants servers emit.
func isJS(resp *http.Response) bool {
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	return strings.Contains(ct, "javascript") ||
		strings.Contains(ct, "ecmascript")
}

// isCSS reports whether the response Content-Type is rewritable CSS.
func isCSS(resp *http.Response) bool {
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	return strings.Contains(ct, "text/css")
}

// readDecompressedBody reads resp.Body, transparently un-gzipping if the
// upstream marked it Content-Encoding: gzip. Removes that header so the
// rewritten response we substitute back is plain text.
func readDecompressedBody(resp *http.Response) ([]byte, error) {
	defer resp.Body.Close()
	if strings.EqualFold(resp.Header.Get("Content-Encoding"), "gzip") {
		gz, err := gzip.NewReader(resp.Body)
		if err != nil {
			return nil, err
		}
		defer gz.Close()
		body, err := io.ReadAll(gz)
		if err != nil {
			return nil, err
		}
		resp.Header.Del("Content-Encoding")
		return body, nil
	}
	return io.ReadAll(resp.Body)
}

// buildClientPassthrough returns the JSON-serializable subset of vhost
// config the client's $rewriter_init reads at boot.
//
// `apiBaseURL` is a single string — the public origin (scheme://host[:port])
// the browser sees for this proxy. There is exactly one such origin; the
// client constructs every URL it needs (cookies.json, ?goto=, proxified
// resources) by appending paths to it.
func buildClientPassthrough(vhost *config.VHost, proxyCfg urlrewrite.ProxyConfig) map[string]any {
	return map[string]any{
		"apiBaseURL":         urlrewrite.APIBase(proxyCfg),
		"cacheKey":           "",
		"source":             vhost.RewriterJSPath,
		"secretCookieName":      vhost.SecretCookieName,
		"userDataEncryption":    vhost.UserDataEncryption,
		"version":               vhost.Version,
		"rewrite_css_selectors": false,
	}
}
