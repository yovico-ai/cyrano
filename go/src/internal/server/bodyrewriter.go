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
	"strconv"
	"strings"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
	"github.com/yovico/cyrano/internal/config"
	"github.com/yovico/cyrano/internal/cssrewrite"
	"github.com/yovico/cyrano/internal/htmlrewrite"
	"github.com/yovico/cyrano/internal/jsrewrite"
	"github.com/yovico/cyrano/internal/proxy"
	"github.com/yovico/cyrano/internal/static"
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
	// Module specifiers name modules: marked as scripts, as an import
	// map's URLs are (spec/Containment.agda Dest).
	jsOpts.ProxifyURL = func(rawURL string, base *url.URL) string {
		return urlrewrite.RewriteDest(rawURL, base, proxyCfg, urlrewrite.DestScript)
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
		// Development aid: CYRANO_DEBUG_R5="[!]<url regexp> <lo> <hi> [<lo> <hi> …][; …]"
		// limits R5 in matching scripts to the accesses whose `[` is in one
		// of the [lo, hi) ranges; a leading "!" applies it to the scripts
		// not matching.
		// The first spec that applies wins.
		if scriptURL != nil {
			if at := debugR5For(os.Getenv("CYRANO_DEBUG_R5"), scriptURL.String()); at != nil {
				opts.DebugR5At = at
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
		// A response that has no body — 1xx, 204, 304, or the answer to a
		// HEAD — passes as it is: its Content-Type and Content-Encoding
		// describe a body it does not carry (a CDN's 304 with gzip made
		// the decompressor fail on the empty body: a 502 on reload).
		if !bodyAllowed(resp) {
			return nil
		}
		ct := resp.Header.Get("Content-Type")

		// What the body is rewritten as (spec/Disposition.agda): by what
		// the request is for — its URL's mark, else Sec-Fetch-Dest — never
		// by changing the Content-Type; the browser decides what it runs.
		// A fetch()/XHR gets the origin's bytes (ns1p.net slices a JSONP
		// reply by position); if the page then runs them — eval, new
		// Function, a script's text, a blob worker — the runtime rewrites
		// them there.
		switch kindOf(resp) {
		case kindAsIs:
		case kindCSS:
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

		case kindHTML:
			// Only HTML a browser renders: a fetch/XHR's text/html is the
			// page's data (Cloudflare's challenge flow API answers text/html
			// that orchestrate.js reads as text).
			body, err := readDecompressedBody(resp)
			if err != nil {
				logger.Warn("rewriter: read upstream body failed",
					"target", target.String(), "ct", ct, "err", err)
				return fmt.Errorf("read upstream body: %w", err)
			}
			var out bytes.Buffer
			isChallenge := isChallengeHTML(body) || isChallengeHost(target.Hostname())

			cfg := htmlrewrite.Config{
				BaseURL:        target,
				Proxy:          proxyCfg,
				RewriterJSPath: static.RuntimeURL(vhost.RewriterJSPath),
				// Every page gets the one runtime. Its patches keep the native
				// surface (ts/client/src/native/surface.ts), so a challenge's
				// integrity and fingerprint checks see native APIs; a challenge
				// page's own scripts are rewritten like any other (below).
				// …except a page under which no script of its own can run
				// (spec/Csp.agda noScriptsRun): it has nothing for the runtime
				// to serve, and natively runs nothing.
				// …nor a frame sandboxed without allow-scripts (spec/Frames.agda
				// inertFrame; the frame's URL says so).
				InjectBootstrap:   !urlrewrite.NoScriptsRun(originalPolicies(resp)) && !proxy.InertFrame(resp),
				ClientPassthrough: pageConfig(clientPassthrough, resp),
				ScriptNonce:       proxy.ScriptNonce(originalPolicies(resp)),
				ExternalBootstrap: !urlrewrite.InlineScriptAllowed(originalPolicies(resp)),
			}
			cfg.OnReferrerPolicy = func(content string) bool { return proxy.RecordMetaPolicy(resp, target, content) }
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

		case kindJS:
			// Challenge and bot-detection scripts (Cloudflare's orchestrate,
			// jsd and Turnstile, Akamai's sensor) are rewritten like any
			// other: their self-checks see their original source.
			body, err := readDecompressedBody(resp)
			if err != nil {
				logger.Warn("rewriter: read upstream JS body failed",
					"target", target.String(), "ct", ct, "err", err)
				return fmt.Errorf("read upstream body: %w", err)
			}
			// What Chromium's ORB blocks cross-origin fails here too
			// (proxy/orb.go; spec/Orb.agda).
			if proxy.OrbBlocks(resp, body) {
				return proxy.ErrOrbBlocked
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
					pre := workerPreamble(urlrewrite.APIBase(proxyCfg), static.RuntimeURL(vhost.RewriterJSPath), clientPassthrough, target.String(), module)
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

// What a response's body is rewritten as (spec/Disposition.agda Kind).
type bodyKind int

const (
	kindAsIs bodyKind = iota
	kindJS
	kindCSS
	kindHTML
)

func (k bodyKind) String() string {
	return [...]string{"none", "js", "css", "html"}[k]
}

// mimeEssence is a Content-Type's essence: up to ";", HTTP whitespace
// trimmed, ASCII-lowercased (spec essence).
func mimeEssence(ct string) string {
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	return strings.ToLower(strings.Trim(ct, " \t\n\r"))
}

var jsEssences = map[string]bool{}

func init() {
	for _, e := range strings.Fields("application/ecmascript application/javascript application/x-ecmascript application/x-javascript text/ecmascript text/javascript text/javascript1.0 text/javascript1.1 text/javascript1.2 text/javascript1.3 text/javascript1.4 text/javascript1.5 text/jscript text/livescript text/x-ecmascript text/x-javascript") {
		jsEssences[e] = true
	}
}

// responseKind decides (spec responseKind): mark is the URL's
// destination mark; sfd the Sec-Fetch-Dest (has: the request sent one);
// ct the Content-Type (hasCT: there is one); sniffed reports whether the
// body sniffs as HTML (asked only for a document with no Content-Type).
func responseKind(mark urlrewrite.Dest, sfd string, has bool, ct string, hasCT bool, sniffed func() bool) bodyKind {
	switch mark {
	case urlrewrite.DestScript:
		return kindJS
	case urlrewrite.DestStyle:
		return kindCSS
	}
	e := mimeEssence(ct)
	isHTMLType := e == "text/html" || e == "application/xhtml+xml"
	if !has {
		switch {
		case !hasCT:
			return kindAsIs
		case isHTMLType:
			return kindHTML
		case jsEssences[e]:
			return kindJS
		case e == "text/css":
			return kindCSS
		}
		return kindAsIs
	}
	switch strings.ToLower(sfd) {
	case "script", "worker", "sharedworker", "serviceworker", "audioworklet", "paintworklet":
		return kindJS
	case "style":
		return kindCSS
	case "document", "iframe", "frame", "embed", "object":
		m, taken := "", false
		if hasCT {
			m, taken = takenMime(ct)
		}
		switch {
		case taken && (m == "text/html" || m == "application/xhtml+xml"):
			return kindHTML
		case (!taken || m == "unknown/unknown" || m == "application/unknown") && sniffed():
			return kindHTML
		}
	}
	return kindAsIs
}

// takenMime is the MIME type Chromium takes from a Content-Type value
// (spec/Disposition.agda takenMime): of each comma-separated item, HTTP
// whitespace skipped, up to ";" or whitespace, lowercased; the last with a
// "/" that is not */*. None: the document's type is sniffed.
func takenMime(ct string) (string, bool) { return urlrewrite.TakenMime(ct) }

// htmlPrefixes are what Chromium's HTML sniff looks for (spec/Disposition
// sniffHtml).
var htmlPrefixes = []string{"<!doctype html", "<script", "<html", "<!--", "<head", "<iframe", "<h1", "<div",
	"<font", "<table", "<a", "<style", "<title", "<b", "<body", "<br", "<p"}

// sniffHTMLBytes: Chromium's HTML sniff (looser than MIME Sniffing §7.1) —
// in the first 512 bytes, after ASCII whitespace (vertical tab too), one
// of htmlPrefixes, case aside, nothing required after it.
func sniffHTMLBytes(body []byte) bool {
	if len(body) > 512 {
		body = body[:512]
	}
	i := 0
	for i < len(body) && strings.IndexByte(" \t\n\v\f\r", body[i]) >= 0 {
		i++
	}
	rest := strings.ToLower(string(body[i:]))
	for _, p := range htmlPrefixes {
		if strings.HasPrefix(rest, p) {
			return true
		}
	}
	return false
}

func kindOf(resp *http.Response) bodyKind {
	sfd, has := "", false
	if resp.Request != nil {
		if v := resp.Request.Header.Values("Sec-Fetch-Dest"); len(v) > 0 {
			sfd, has = v[0], true
		}
	}
	cts := resp.Header.Values("Content-Type")
	ct, hasCT := strings.Join(cts, ","), len(cts) > 0 // the lines, as one list (Chromium reads them all)
	return responseKind(proxy.RequestDest(resp), sfd, has, ct, hasCT, func() bool { return sniffedHTML(resp) })
}

// replaceBody substitutes resp.Body with the given bytes, fixing
// Content-Length and dropping any incompatible Transfer-Encoding header.
func replaceBody(resp *http.Response, body []byte) {
	resp.Body = proxy.RewrittenBody(body)
	resp.ContentLength = int64(len(body))
	resp.Header.Set("Content-Length", fmt.Sprintf("%d", len(body)))
	resp.Header.Del("Transfer-Encoding")
}

// sniffedHTML reports whether a document whose type Chromium does not take
// (no Content-Type, none with a "/", unknown/unknown, …: takenMime) is one
// it renders as HTML: it sniffs the first bytes (sniffHTMLBytes).
// measureadv.com's sync frame is such a page; unrewritten, its pixels went
// straight to the origins. The body is read (decompressed) to look at it
// and put back; the Content-Type stays as the origin sent it.
func sniffedHTML(resp *http.Response) bool {
	if resp.Request == nil {
		return false
	}
	body, err := readDecompressedBody(resp)
	if err != nil {
		replaceBody(resp, nil)
		return false
	}
	replaceBody(resp, body)
	return sniffHTMLBytes(body)
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
// bodyAllowed reports whether the response can carry a body (RFC 9110 §6.4.1).
func bodyAllowed(resp *http.Response) bool {
	if resp.Request != nil && resp.Request.Method == http.MethodHead {
		return false
	}
	return resp.StatusCode >= 200 && resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusNotModified
}

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

// debugR5For reads CYRANO_DEBUG_R5 ("[!]<url regexp> <lo> <hi> [<lo> <hi>
// …][; …]") for the script at scriptURL: whether R5 applies to the access
// whose "[" is at pos, or nil when no spec applies (R5 everywhere). A spec
// with no ranges, an odd count or a bad regexp is skipped; the first that
// applies wins; a number that does not parse is 0.
func debugR5For(env, scriptURL string) func(pos int) bool {
	for _, spec := range strings.Split(env, ";") {
		f := strings.Fields(spec)
		if len(f) < 3 || len(f)%2 == 0 {
			continue
		}
		pat, invert := strings.CutPrefix(f[0], "!")
		re, err := regexp.Compile(pat)
		if err != nil || re.MatchString(scriptURL) == invert {
			continue
		}
		var ranges [][2]int
		for i := 1; i+1 < len(f); i += 2 {
			lo, _ := strconv.Atoi(f[i])
			hi, _ := strconv.Atoi(f[i+1])
			ranges = append(ranges, [2]int{lo, hi})
		}
		return func(pos int) bool {
			for _, r := range ranges {
				if pos >= r[0] && pos < r[1] {
					return true
				}
			}
			return false
		}
	}
	return nil
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
	cfg := clientBase(vhost, proxyCfg)
	// The portal toolbar (ts/client/src/ui/toolbar.ts; spec/Toolbar.agda):
	// its home button goes to the portal's main page.
	if vhost.Toolbar {
		cfg["toolbar"] = map[string]any{"home": urlrewrite.APIBase(proxyCfg) + "/"}
	}
	return cfg
}

func clientBase(vhost *config.VHost, proxyCfg urlrewrite.ProxyConfig) map[string]any {
	return map[string]any{
		"apiBaseURL":            urlrewrite.APIBase(proxyCfg),
		"cacheKey":              "",
		"source":                static.RuntimeURL(vhost.RewriterJSPath),
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
	if n := proxy.ScriptNonce(originalPolicies(resp)); n != "" {
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
		src, _ := json.Marshal(urlrewrite.APIBase(proxyCfg) + static.RuntimeURL(vhost.RewriterJSPath))
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
		_, _ = w.Write([]byte(htmlrewrite.FailClosed + "window.$rewriter=window.$rewriter_init(window," + string(clean) + ").inject();" +
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
