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

	"github.com/andybalholm/brotli"
	"github.com/yovico/cyrano/internal/config"
	"github.com/yovico/cyrano/internal/cssrewrite"
	"github.com/yovico/cyrano/internal/htmlrewrite"
	"github.com/yovico/cyrano/internal/jsrewrite"
	"github.com/yovico/cyrano/internal/proxy"
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
func makeBodyRewriter(vhost *config.VHost, proxyCfg urlrewrite.ProxyConfig, logger *slog.Logger, jar *proxy.SessionJar, sessName string) func(*http.Response, *url.URL) error {
	clientPassthrough := buildClientPassthrough(vhost, proxyCfg)
	jsOpts := jsrewrite.DefaultOptions()
	jsOpts.Logger = logger.With("component", "jsrewrite")
	jsOpts.ProxifyURL = func(rawURL string, base *url.URL) string {
		return urlrewrite.Rewrite(rawURL, base, proxyCfg)
	}
	// rewriteJSFor returns a rewriter closure bound to scriptURL so that
	// relative import() specifiers are resolved against the right base.
	rewriteJSFor := func(scriptURL *url.URL) func([]byte) []byte {
		opts := jsOpts
		opts.BaseURL = scriptURL
		return func(src []byte) []byte { return jsrewrite.Rewrite(src, opts) }
	}

	cssLogger := logger.With("component", "cssrewrite")
	rewriteCSS := func(target *url.URL) func([]byte) []byte {
		return func(src []byte) []byte {
			return cssrewrite.Rewrite(src, cssrewrite.Options{
				BaseURL: target, Proxy: proxyCfg, Logger: cssLogger,
			})
		}
	}

	return func(resp *http.Response, target *url.URL) error {
		fixContentType(resp, target)
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
			isChallenge := isChallengeHTML(body) || isChallengeHost(target.Hostname())

			var pageCookies []string
			if jar != nil && sessName != "" && resp.Request != nil {
				if sessID, _ := resp.Request.Context().Value(proxy.SessionContextKey{}).(string); sessID != "" {
					pageCookies = jar.ForPageCookies(sessID, target.Host)
				}
			}

			cfg := htmlrewrite.Config{
				BaseURL:           target,
				Proxy:             proxyCfg,
				RewriterJSPath:    vhost.RewriterJSPath,
				HeadInjectionPath: vhost.HeadInjectionPath,
				// Don't inject our bootstrap into challenge pages — challenge.js
				// does PoW/fingerprinting and must run in an unmodified environment.
				// Our fetch/XHR patches interfere with its API calls and cause the
				// PoW solution to compute as all-zeros, failing the challenge.
				InjectBootstrap:   !isChallenge,
				ClientPassthrough: clientPassthrough,
				PageCookies:       pageCookies,
			}
			if !isChallenge {
				cfg.RewriteInlineJS = rewriteJSFor(target)
				cfg.RewriteInlineCSS = rewriteCSS(target)
			} else {
				logger.Debug("rewriter: html passthrough (challenge page, no injection)", "target", target.String())
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
			// Skip rewriting challenge scripts and any content from challenge hosts.
			if isChallengeScript(target) || isChallengeHost(target.Hostname()) {
				logger.Debug("rewriter: js passthrough (challenge script)", "target", target.String())
				break
			}
			body, err := readDecompressedBody(resp)
			if err != nil {
				logger.Warn("rewriter: read upstream JS body failed",
					"target", target.String(), "ct", ct, "err", err)
				return fmt.Errorf("read upstream body: %w", err)
			}
			rewritten := rewriteJSFor(target)(body)
			// Worker scripts (Sec-Fetch-Dest: worker/sharedworker) run in a
			// DedicatedWorkerGlobalScope that has no window and no HTML bootstrap
			// chain — $rewriter is never defined. Prepend a shim that:
			//   1. defines $rewriter with passthrough stubs + URL proxification
			//   2. patches self.importScripts so the URLs it loads go through
			//      the proxy (and thus get AST-rewritten with $rewriter calls
			//      the shim can handle)
			//   3. patches self.fetch / XMLHttpRequest for completeness
			if resp.Request != nil {
				dest := strings.ToLower(resp.Request.Header.Get("Sec-Fetch-Dest"))
				if dest == "worker" || dest == "sharedworker" {
					shim := buildWorkerShim(urlrewrite.APIBase(proxyCfg))
					rewritten = append(shim, rewritten...)
					// Prevent the browser from caching the shimmed worker script.
					// Without this the browser serves the pre-shim copy from cache
					// on subsequent loads, causing $rewriter to be undefined inside
					// the worker (leading to silent challenge failures).
					resp.Header.Set("Cache-Control", "no-store")
					resp.Header.Del("Expires")
					resp.Header.Del("Last-Modified")
					resp.Header.Del("ETag")
					logger.Debug("rewriter: prepended worker shim", "target", target.String())
				}
			}
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

// isChallengeScript reports whether the URL is a bot-challenge script that
// must not be rewritten. These scripts do browser fingerprinting; any AST
// transformation breaks them. URL patterns seen in the wild:
//
//	/__challenge_*/challenge.js
//	/__cf_chl_*/challenge.js
//	/cdn-cgi/challenge-platform/*/   (Cloudflare Bot Management / jsd/main.js)
//	/<b64seg>/<b64seg>/...?v=<uuid>  (Akamai Bot Manager — randomised paths)
func isChallengeScript(u *url.URL) bool {
	p := u.Path
	if strings.Contains(p, "/cdn-cgi/challenge-platform/") {
		return true
	}
	if (strings.Contains(p, "/__challenge_") || strings.Contains(p, "/__cf_chl")) &&
		strings.HasSuffix(p, "/challenge.js") {
		return true
	}
	return isAkamaiScript(u)
}

// isAkamaiScript detects Akamai Bot Manager scripts by their distinctive URL
// shape: all path segments are URL-safe base64 characters (no dots, no
// extension) and the query string contains a v= parameter with a UUID value.
//
// Akamai serves these scripts from the origin domain itself at a randomised
// path that rotates per-deployment, making content-based detection unreliable.
func isAkamaiScript(u *url.URL) bool {
	// Must have a v= query param that looks like a UUID.
	if !looksLikeUUID(u.Query().Get("v")) {
		return false
	}
	// Every path segment must be non-empty and purely [A-Za-z0-9_-] (no dots).
	segs := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(segs) < 2 {
		return false
	}
	for _, seg := range segs {
		if seg == "" {
			return false
		}
		for _, c := range seg {
			if !('a' <= c && c <= 'z') && !('A' <= c && c <= 'Z') &&
				!('0' <= c && c <= '9') && c != '_' && c != '-' {
				return false
			}
		}
	}
	return true
}

// looksLikeUUID reports whether s is a UUID in the standard
// xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx format.
func looksLikeUUID(s string) bool {
	return len(s) == 36 && s[8] == '-' && s[13] == '-' && s[18] == '-' && s[23] == '-'
}

// isChallengeJSPath reports whether the request path looks like a Cloudflare
// Bot Management script that may arrive without a usable Referer (e.g. from an
// about:blank sandbox). Used by the server to return an empty 200 JS response
// instead of a 404 when Referer-based routing cannot resolve an upstream.
func isChallengeJSPath(path string) bool {
	lower := strings.ToLower(path)
	return strings.Contains(lower, "/cdn-cgi/challenge-platform/") &&
		strings.HasSuffix(lower, ".js")
}

// isChallengeHost reports whether all content from this host must be passed
// through without injection or JS rewriting. Cloudflare Turnstile widget pages
// are served from challenges.cloudflare.com and do browser fingerprinting that
// must run unmodified; injecting rewriter.js also fails because their CSP is
// nonce-gated around a different nonce than the one on our injected script.
func isChallengeHost(host string) bool {
	return strings.EqualFold(host, "challenges.cloudflare.com")
}

// isChallengeHTML reports whether the HTML body is a bot-challenge interstitial.
// Cloudflare challenge pages reference their challenge script via a distinctive
// path prefix; that reference appears in the raw HTML before any rewriting.
func isChallengeHTML(body []byte) bool {
	return bytes.Contains(body, []byte("/__challenge_")) ||
		bytes.Contains(body, []byte("/__cf_chl"))
}

// isCSS reports whether the response Content-Type is rewritable CSS.
func isCSS(resp *http.Response) bool {
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	return strings.Contains(ct, "text/css")
}

// fixContentType corrects a generic Content-Type (text/plain,
// application/octet-stream) when the URL path has an unambiguous extension.
// Some CDNs misconfigure MIME types, and browsers enforce strict MIME checking
// for stylesheets — a text/plain .css file is silently rejected.
func fixContentType(resp *http.Response, target *url.URL) {
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	if ct != "" &&
		!strings.HasPrefix(ct, "text/plain") &&
		!strings.HasPrefix(ct, "application/octet-stream") {
		return // already a specific type — leave it alone
	}
	path := strings.ToLower(target.Path)
	switch {
	case strings.HasSuffix(path, ".css"):
		resp.Header.Set("Content-Type", "text/css; charset=utf-8")
	case strings.HasSuffix(path, ".js") || strings.HasSuffix(path, ".mjs"):
		resp.Header.Set("Content-Type", "application/javascript; charset=utf-8")
	}
}

// readDecompressedBody reads resp.Body, transparently decompressing gzip or
// brotli content. Removes Content-Encoding so the rewritten response we
// substitute back is treated as plain text by the browser.
func readDecompressedBody(resp *http.Response) ([]byte, error) {
	defer resp.Body.Close()
	switch strings.ToLower(resp.Header.Get("Content-Encoding")) {
	case "gzip":
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
	case "br":
		body, err := io.ReadAll(brotli.NewReader(resp.Body))
		if err != nil {
			return nil, err
		}
		resp.Header.Del("Content-Encoding")
		return body, nil
	default:
		return io.ReadAll(resp.Body)
	}
}

// buildWorkerShim returns a self-invoking JS block to prepend to Worker
// scripts (Sec-Fetch-Dest: worker/sharedworker). Workers have no window and
// no HTML bootstrap chain, so $rewriter is never defined — any AST-rewritten
// code that calls $rewriter.wrap_* would throw ReferenceError.
//
// The shim:
//  1. defines a minimal $rewriter stub (URL methods proxify; others passthrough)
//  2. patches self.importScripts to proxify URL arguments so the scripts those
//     loads go through the proxy and get AST-rewritten with $rewriter calls
//  3. patches self.fetch / XMLHttpRequest for completeness
//
// proxyBase is the proxy's public origin, e.g. "https://proxy.example.com".
func buildWorkerShim(proxyBase string) []byte {
	// fmt.Sprintf %q produces a Go-quoted double-quoted string which is also
	// a valid JavaScript string literal for any ASCII-safe URL.
	b := fmt.Sprintf("%q", proxyBase)
	return []byte(`(function(){var _b=` + b + `;` +
		`function _p(u){` +
		`if(!u||typeof u!=="string")return u;` +
		`if(u.charAt(0)==="#"||/^(javascript:|data:|blob:|mailto:|tel:|about:)/i.test(u))return u;` +
		`try{var a=new URL(u,self.location.href);` +
		`if(!/^https?:$/.test(a.protocol)&&!/^wss?:$/.test(a.protocol))return u;` +
		`var bh=new URL(_b).host;if(a.host===bh)return u;` +
		`var r=_b+"/cyrano/"+a.protocol.slice(0,-1)+"/"+a.host+a.pathname;` +
		`if(a.search)r+=a.search;return r;` +
		`}catch(e){return u;}}` +
		`if(typeof $rewriter==="undefined"){self.$rewriter={` +
		`wrap_get_location:function(l){return l;},` +
		`wrap_set_location:function(l,s){return{set value(v){s(v);},get value(){return l.href;}};},` +
		`wrap_location:function(a){return a.obj;},` +
		`wrap_get_top_window:function(t){return t;},` +
		`wrap_top_window:function(a){return a.obj;},` +
		`wrap_get_parent_window:function(t){return t;},` +
		`wrap_parent_window:function(a){return a.obj;},` +
		`wrap_document_write:function(a){return a.obj;},` +
		`wrap_postMessage:function(a){return a.obj;},` +
		`wrap_eval:function(e){return e;},` +
		`wrap_eval_arg:function(e,a){return e(a);},` +
		`wrap_eval_memexp:function(o){return o;},` +
		`wrap_member_expression:function(o){return o;},` +
		`wrap_import_arg:function(s){return typeof s==="string"?_p(s):s;},` +
		`wrap_worker_url:function(u){var s=u!=null?String(u):null;return s?_p(s):u;},` +
		`};}` +
		`var _is=self.importScripts;` +
		`if(typeof _is==="function"){self.importScripts=function(){` +
		`var a=[];for(var i=0;i<arguments.length;i++)a.push(_p(String(arguments[i])));` +
		`return _is.apply(self,a);};}` +
		`var _f=self.fetch;` +
		`if(typeof _f==="function"){self.fetch=function(i,o){` +
		`if(typeof i==="string")i=_p(i);` +
		`else if(typeof URL!=="undefined"&&i instanceof URL)i=_p(i.href);` +
		`return _f.call(self,i,o);};}` +
		`if(typeof XMLHttpRequest!=="undefined"){var _xo=XMLHttpRequest.prototype.open;` +
		`XMLHttpRequest.prototype.open=function(m,u){` +
		`var a=[];for(var j=0;j<arguments.length;j++)a[j]=arguments[j];` +
		`a[1]=_p(typeof u==="string"?u:String(u));return _xo.apply(this,a);};}` +
		`})();` + "\n")
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
