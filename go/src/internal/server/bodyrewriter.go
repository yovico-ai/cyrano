package server

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"regexp"
	"strings"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
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
func makeBodyRewriter(vhost *config.VHost, proxyCfg urlrewrite.ProxyConfig, logger *slog.Logger, jar *proxy.SessionJar, sessName string, prettify bool) func(*http.Response, *url.URL) error {
	clientPassthrough := buildClientPassthrough(vhost, proxyCfg)
	jsOpts := jsrewrite.DefaultOptions()
	// Development aid: CYRANO_DEBUG_JS_OFF lists rewrite rules (Options
	// field names) to switch off, for finding which one a site minds.
	for _, name := range strings.Split(os.Getenv("CYRANO_DEBUG_JS_OFF"), ",") {
		if f := reflect.ValueOf(&jsOpts).Elem().FieldByName(strings.TrimSpace(name)); f.IsValid() && f.Kind() == reflect.Bool {
			f.SetBool(false)
		}
	}
	jsOpts.Logger = logger.With("component", "jsrewrite")
	jsOpts.ProxifyURL = func(rawURL string, base *url.URL) string {
		return urlrewrite.Rewrite(rawURL, base, proxyCfg)
	}
	// rewriteJSFor returns a rewriter closure bound to scriptURL so that
	// relative import() specifiers are resolved against the right base.
	rewriteJSFor := func(scriptURL *url.URL) func([]byte) []byte {
		opts := jsOpts
		opts.BaseURL = scriptURL
		// Development aid (CYRANO_DEBUG_NO_JS): scripts are served as the
		// origin sent them — for telling whether a site notices the
		// rewritten source or the runtime (cmd/mitmprobe, identity mode).
		// A value other than "1" is a regexp: only scripts whose URL
		// matches it are left alone.
		if v := os.Getenv("CYRANO_DEBUG_NO_JS"); v != "" {
			if re, err := regexp.Compile(v); v == "1" || err != nil || (scriptURL != nil && re.MatchString(scriptURL.String())) {
				return func(src []byte) []byte { return src }
			}
		}
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
		sniffed := sniffedHTML(resp)

		switch {
		case fetchedAsData(resp) && !isHTML(resp):
			// CSS or JS read by a script through fetch()/XHR is data to the
			// page: it must get the bytes the origin sent (ns1p.net slices
			// a JSONP reply by position; reformatted, its JSON.parse threw).
			// If the page then runs it — eval, new Function, a script's
			// text, a blob worker — the client runtime rewrites it there.
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

		case isHTML(resp) || sniffed:
			// Only rewrite HTML that will actually be rendered by a browser.
			// Responses to fetch/XHR (Sec-Fetch-Dest: empty) carry text/html
			// content consumed programmatically — e.g. Cloudflare's challenge
			// platform returns text/html from its flow API endpoint, and
			// orchestrate.js reads it as text. Injecting bootstrap scripts
			// into such responses corrupts the payload.
			if resp.Request != nil {
				dest := strings.ToLower(resp.Request.Header.Get("Sec-Fetch-Dest"))
				if dest != "" && dest != "document" && dest != "frame" && dest != "iframe" && dest != "embed" && dest != "object" {
					break
				}
			}
			body, err := readDecompressedBody(resp)
			if err != nil {
				logger.Warn("rewriter: read upstream body failed",
					"target", target.String(), "ct", ct, "err", err)
				return fmt.Errorf("read upstream body: %w", err)
			}
			var out bytes.Buffer
			isChallenge := isChallengeHTML(body) || isChallengeHost(target.Hostname())

			cfg := htmlrewrite.Config{
				BaseURL:           target,
				Proxy:             proxyCfg,
				RewriterJSPath:    vhost.RewriterJSPath,
				HeadInjectionPath: vhost.HeadInjectionPath,
				// Every page gets the one runtime. Its patches keep the native
				// surface (ts/client/src/native/surface.ts), so a challenge's
				// integrity and fingerprint checks see native APIs; a challenge
				// page's own scripts are rewritten like any other (below).
				InjectBootstrap:   true,
				ClientPassthrough: pageConfig(clientPassthrough, resp),
				ScriptNonce:       proxy.ScriptNonce(resp.Header.Values("Content-Security-Policy")),
				ExternalBootstrap: !urlrewrite.InlineScriptAllowed(originalPolicies(resp)),
			}
			cfg.OnReferrerPolicy = func(content string) bool { return proxy.RecordMetaPolicy(target, content) }
			if cfg.ExternalBootstrap {
				cfg.ClientPassthrough["xb"] = true // documents this page writes need the same
			}
			// Challenge pages are rewritten like any other. Their scripts check
			// their own source, which reads back as the origin wrote it
			// (jsrewrite: marked, invertible edits); left unrewritten, they
			// read `location` natively and report the proxy's URL (Turnstile
			// then fails with 600010).
			cfg.RewriteInlineJS = rewriteJSFor(target)
			cfg.RewriteInlineCSS = rewriteCSS(target)
			if isChallenge {
				// Record this session's challenge origin so bare-path /cdn-cgi/
				// requests from blob workers (which have no Referer) can be routed
				// to the correct upstream without needing a /cyrano/ URL prefix.
				if jar != nil && sessName != "" && resp.Request != nil {
					if sessID, _ := resp.Request.Context().Value(proxy.SessionContextKey{}).(string); sessID != "" {
						jar.StoreChallengeOrigin(sessID, target.Scheme, target.Host)
					}
				}
				logger.Debug("rewriter: challenge page", "target", target.String())
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
			// Challenge and bot-detection scripts (Cloudflare's orchestrate,
			// jsd and Turnstile, Akamai's sensor) are rewritten like any
			// other: their self-checks see their original source.
			body, err := readDecompressedBody(resp)
			if err != nil {
				logger.Warn("rewriter: read upstream JS body failed",
					"target", target.String(), "ct", ct, "err", err)
				return fmt.Errorf("read upstream body: %w", err)
			}
			rewritten := rewriteJSFor(target)(body)
			if prettify {
				rewritten = jsrewrite.Prettify(rewritten)
			}
			// Pass the upstream's cache headers through unchanged. These bundles
			// are content-hash-immutable (e.g. vendor.<hash>.js) and the JS
			// rewriter is deterministic, so the browser may safely cache the
			// rewritten bytes under the upstream's (often immutable) Cache-Control.
			// Forcing no-store here defeated that: every reference re-fetched, and
			// with x.com's preload+script double-load the refetch volume piled up
			// streams on the one coalesced HTTP/2 connection until it wedged.
			// Caveat: a rewriter change will NOT invalidate an already-cached copy
			// — during rewriter development, hard-reload or use "Disable cache".
			// Worker scripts (Sec-Fetch-Dest: worker/sharedworker) run in a
			// worker scope with no window and no HTML bootstrap: prepend the
			// client runtime's worker preamble (workerPreamble).
			if resp.Request != nil {
				dest := strings.ToLower(resp.Request.Header.Get("Sec-Fetch-Dest"))
				if dest == "worker" || dest == "sharedworker" {
					module := strings.EqualFold(resp.Request.Header.Get("Sec-Fetch-Mode"), "cors")
					pre := workerPreamble(urlrewrite.APIBase(proxyCfg), vhost.RewriterJSPath, clientPassthrough, target.String(), module)
					rewritten = append(pre, rewritten...)
					// Prevent the browser from caching the shimmed worker script.
					// Without this the browser serves the pre-shim copy from cache
					// on subsequent loads, causing $rewriter to be undefined inside
					// the worker (leading to silent challenge failures).
					resp.Header.Set("Cache-Control", "no-store")
					resp.Header.Del("Expires")
					resp.Header.Del("Last-Modified")
					resp.Header.Del("ETag")
					logger.Debug("rewriter: prepended worker preamble", "target", target.String())
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

// sniffedHTML reports whether a document with no Content-Type at all is
// one the browser renders as HTML: it sniffs the type from the first bytes
// (WHATWG MIME Sniffing, "identifying an unknown MIME type"; Go's
// http.DetectContentType is that algorithm). measureadv.com's sync frame is
// such a page; unrewritten, its pixels went straight to the origins. The
// body is read (decompressed) to look at it and put back; the response
// keeps having no Content-Type, as it has for the page.
func sniffedHTML(resp *http.Response) bool {
	if len(resp.Header.Values("Content-Type")) != 0 || resp.Request == nil {
		return false
	}
	switch strings.ToLower(resp.Request.Header.Get("Sec-Fetch-Dest")) {
	case "document", "iframe", "frame", "embed", "object":
	default:
		return false
	}
	body, err := readDecompressedBody(resp)
	if err != nil {
		replaceBody(resp, nil)
		return false
	}
	replaceBody(resp, body)
	head := body
	if len(head) > 512 {
		head = head[:512]
	}
	return strings.HasPrefix(http.DetectContentType(head), "text/html")
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
// must not be rewritten. These scripts do browser fingerprinting that requires
// an unmodified execution environment. URL patterns seen in the wild:
//
//	/__challenge_*/challenge.js
//	/__cf_chl_*/challenge.js
//	/<b64seg>/<b64seg>/...?v=<uuid>  (Akamai Bot Manager — randomised paths)
//
// Cloudflare challenge-platform scripts (orchestrate, jsd, etc.) are NOT
// excluded here — they are JS-rewritten so that location.* accesses are
// wrapped via $rewriter.wrap_get_location, and the challenge page injects a
// minimal $rewriter shim that returns the upstream origin from that wrapper.
func isChallengeScript(u *url.URL) bool {
	p := u.Path
	if (strings.Contains(p, "/__challenge_") || strings.Contains(p, "/__cf_chl")) &&
		strings.HasSuffix(p, "/challenge.js") {
		return true
	}
	return isAkamaiScript(u)
}

// isJSDScript detects Cloudflare's "jsd" (JavaScript Detection) bot-telemetry
// scripts, e.g. /cdn-cgi/challenge-platform/scripts/jsd/main.js and the
// versioned /cdn-cgi/challenge-platform/h/<x>/scripts/jsd/<hash>/main.js. These
// are obfuscated and self-integrity-checked; rewriting them makes the script
// spin forever (see the passthrough note in makeBodyRewriter), so they must be
// served unmodified.
func isJSDScript(u *url.URL) bool {
	p := strings.ToLower(u.Path)
	return strings.Contains(p, "/cdn-cgi/challenge-platform/") && strings.Contains(p, "/scripts/jsd/")
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
//
// Two challenge styles:
//   - Legacy / JS-challenge:  /__challenge_*/challenge.js  or  /__cf_chl*/
//   - Managed / Turnstile:    /cdn-cgi/challenge-platform/  (orchestrate endpoint)
func isChallengeHTML(body []byte) bool {
	return bytes.Contains(body, []byte("/__challenge_")) ||
		bytes.Contains(body, []byte("/__cf_chl")) ||
		// _cf_chl_opt is the Cloudflare interstitial's config object — present
		// only on an actual challenge page. The "h/" segment (h/b, h/g) is the
		// real challenge tree (orchestrate, fo, ci). We deliberately do NOT match
		// the bare "/cdn-cgi/challenge-platform/" prefix: Cloudflare injects a
		// passive telemetry script (/cdn-cgi/challenge-platform/scripts/jsd/main.js)
		// into NORMAL pages too, and matching it misclassifies every proxied app
		// page as a challenge — so it gets the minimal challenge shim instead of
		// the full $rewriter client, and the app breaks ($rewriter undefined).
		bytes.Contains(body, []byte("_cf_chl_opt")) ||
		bytes.Contains(body, []byte("/cdn-cgi/challenge-platform/h/"))
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

// readDecompressedBody reads resp.Body, transparently decompressing gzip,
// brotli, or zstd content. Removes Content-Encoding so the rewritten response
// we substitute back is treated as plain text by the browser. zstd is included
// because a real Chrome advertises it in Accept-Encoding (see the Director);
// advertising an encoding we can't decode would corrupt rewritten responses.
// OriginalSizesMetric is the Server-Timing metric that carries, for the
// client runtime, the size of a body as the origin sent it — encoded (on
// the wire) and decoded — where the proxy changed the body: a script reads
// both from the response's performance entry (encodedBodySize,
// decodedBodySize, transferSize), and an origin that knows what it served
// can tell a rewritten body by them (Cloudflare's challenge reports the
// sizes of its own frame and scripts). Server-Timing rides with the entry
// itself, for documents and subresources alike; the runtime answers the
// size getters from it and hides the metric
// (ts/client/src/patches/install.ts, patchPerformanceEntryNames).
const OriginalSizesMetric = "crnb"

// countingReader counts the bytes read through it.
type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// readDecompressedBody reads the whole body, decoded, and notes its
// original sizes on the response (OriginalSizesMetric) the first time.
func readDecompressedBody(resp *http.Response) ([]byte, error) {
	raw := &countingReader{r: resp.Body}
	body, err := readDecoded(resp, raw)
	if err != nil {
		return nil, err
	}
	noted := false
	for _, v := range resp.Header.Values("Server-Timing") {
		if strings.HasPrefix(v, OriginalSizesMetric+";") {
			noted = true
		}
	}
	if !noted {
		resp.Header.Add("Server-Timing", fmt.Sprintf(`%s;desc="%d-%d"`, OriginalSizesMetric, raw.n, len(body)))
	}
	return body, nil
}

func readDecoded(resp *http.Response, raw io.Reader) ([]byte, error) {
	defer resp.Body.Close()
	switch strings.ToLower(resp.Header.Get("Content-Encoding")) {
	case "gzip":
		gz, err := gzip.NewReader(raw)
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
		body, err := io.ReadAll(brotli.NewReader(raw))
		if err != nil {
			return nil, err
		}
		resp.Header.Del("Content-Encoding")
		return body, nil
	case "zstd":
		zr, err := zstd.NewReader(raw)
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		body, err := io.ReadAll(zr)
		if err != nil {
			return nil, err
		}
		resp.Header.Del("Content-Encoding")
		return body, nil
	default:
		return io.ReadAll(raw)
	}
}

// workerPreamble is what runs first in a Worker script cyrano serves
// (Sec-Fetch-Dest: worker/sharedworker): it loads the one client runtime
// into the worker's own scope and initializes it for the worker's original
// URL — the same preamble ts/client/src/patches/blob-worker-source.ts puts
// before a Blob worker's source. A worker has no window and no HTML
// bootstrap, so without it the rewritten code's $rewriter calls would throw,
// and the worker's own fetch/XHR/importScripts would not be proxified.
//
// A module worker (fetched with Sec-Fetch-Mode: cors) has no importScripts,
// and evaluates its static imports before its body: it gets an import of
// the init module (WorkerInitPath) first, which runs the same preamble.
func workerPreamble(proxyBase, rewriterPath string, config map[string]any, workerURL string, module bool) []byte {
	if module {
		src, _ := json.Marshal(proxyBase + WorkerInitPath + "?u=" + url.QueryEscape(workerURL))
		return []byte("import " + string(src) + ";\n")
	}
	cfg, err := json.Marshal(config)
	if err != nil {
		cfg = []byte("{}")
	}
	src, _ := json.Marshal(proxyBase + rewriterPath)
	href, _ := json.Marshal(workerURL)
	// Under Trusted Types (a worker has its creator's or its own policy)
	// importScripts takes a TrustedScriptURL: made by the runtime's policy,
	// which the runtime is then handed (a policy name can be used once).
	tt, _ := json.Marshal(urlrewrite.TrustedTypesPolicy)
	return []byte("(function(p,i){try{p=self.trustedTypes.createPolicy(" + string(tt) +
		",{createHTML:i,createScript:i,createScriptURL:i})}catch(e){p=null}" +
		"importScripts(p?p.createScriptURL(" + string(src) + "):" + string(src) + ");" +
		"self.$rewriter=self.$rewriter_init_worker(" + string(cfg) + "," + string(href) + ",p);" +
		"self.$__crn_key__=null})(null,function(s){return s});\n")
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
		"apiBaseURL":            urlrewrite.APIBase(proxyCfg),
		"cacheKey":              "",
		"source":                vhost.RewriterJSPath,
		"version":               vhost.Version,
		"rewrite_css_selectors": false,
		// The runtime's Trusted Types policy (urlrewrite.RewriteCSP admits it).
		"tt": urlrewrite.TrustedTypesPolicy,
	}
}

// pageConfig is the client config for one document: the vhost's, plus
// document.referrer — natively the Referer the document was requested
// with, which is what the upstream was sent for it (proxy.directFetchHeaders).
func pageConfig(base map[string]any, resp *http.Response) map[string]any {
	cp := make(map[string]any, len(base)+2)
	for k, v := range base {
		cp[k] = v
	}
	referrer := ""
	if resp.Request != nil {
		referrer = resp.Request.Header.Get("Referer")
	}
	cp["referrer"] = referrer
	// The nonce the page's CSP asks of scripts, for bootstraps the client
	// writes itself (document.write'd documents).
	if n := proxy.ScriptNonce(resp.Header.Values("Content-Security-Policy")); n != "" {
		cp["nonce"] = n
	}
	return cp
}

// WorkerInitPath serves a module worker's preamble (workerPreamble): the
// client runtime, initialized for the worker's original URL (?u=).
const WorkerInitPath = "/cyrano-worker-init.js"

func workerInitHandler(vhost *config.VHost, proxyCfg urlrewrite.ProxyConfig) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		workerURL := r.URL.Query().Get("u")
		cfg, err := json.Marshal(buildClientPassthrough(vhost, proxyCfg))
		if err != nil {
			cfg = []byte("{}")
		}
		src, _ := json.Marshal(urlrewrite.APIBase(proxyCfg) + vhost.RewriterJSPath)
		href, _ := json.Marshal(workerURL)
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte("import " + string(src) + ";\n" +
			"self.$rewriter=self.$rewriter_init_worker(" + string(cfg) + "," + string(href) + ");" +
			"self.$__crn_key__=null;\n"))
	})
}

// originalPolicies are the response's Content-Security-Policy values as the
// origin sent them (the proxy's header pass has translated the header by
// now and carries the origin's in proxy.OriginalHeadersName).
func originalPolicies(resp *http.Response) []string {
	var orig map[string][]string
	if json.Unmarshal([]byte(resp.Header.Get("Crn-H")), &orig) == nil {
		if v, ok := orig["content-security-policy"]; ok {
			return v
		}
	}
	return resp.Header.Values("Content-Security-Policy")
}

// bootHandler serves htmlrewrite.BootPath: the bootstrap's second script
// for a page whose CSP forbids inline scripts.
func bootHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cfg := r.URL.Query().Get("c")
		// Only a JSON object, re-serialized: nothing else reaches the script.
		var parsed map[string]any
		if json.Unmarshal([]byte(cfg), &parsed) != nil {
			http.Error(w, "bad config", http.StatusBadRequest)
			return
		}
		clean, _ := json.Marshal(parsed)
		href, _ := json.Marshal(r.URL.Query().Get("u"))
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte("window.$rewriter=window.$rewriter_init(window," + string(clean) + ").inject();" +
			"$rewriter.set_location(" + string(href) + ");" +
			`(function(s,p){p=s.previousElementSibling;if(p&&p.src&&p.tagName==="SCRIPT")p.remove();s.remove()})(document.currentScript);`))
	})
}

// fetchedAsData: the response answers fetch() or XHR (Sec-Fetch-Dest:
// empty), so a script reads its body; nothing parses it as a document,
// stylesheet or script.
func fetchedAsData(resp *http.Response) bool {
	return resp.Request != nil && strings.EqualFold(resp.Request.Header.Get("Sec-Fetch-Dest"), "empty")
}
