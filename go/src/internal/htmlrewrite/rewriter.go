package htmlrewrite

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/yovico/cyrano/internal/urlrewrite"
	"golang.org/x/net/html"
)

// Rewrite reads an HTML document from r, applies the configured rules, and
// writes the rewritten document to w. The output is byte-streamable — we
// emit each token as soon as it's processed.
//
// Returns the first non-EOF error from either side of the pipe.
func Rewrite(w io.Writer, r io.Reader, cfg Config) error {
	if cfg.BaseURL == nil {
		return errors.New("htmlrewrite: Config.BaseURL required")
	}
	z := html.NewTokenizer(r)
	bootstrapDone := false  // guard against multiple <head> (e.g. nested srcdoc)
	inScript := false       // currently inside <script>...</script> with rewritable content
	inStyle := false        // currently inside <style>...</style>
	inNoscript := false     // currently inside <noscript>...</noscript>
	emitted := bytes.Buffer{}

	flush := func() error {
		if emitted.Len() == 0 {
			return nil
		}
		_, err := w.Write(emitted.Bytes())
		emitted.Reset()
		return err
	}
	emitRaw := func(p []byte) {
		emitted.Write(p)
	}

	for {
		tt := z.Next()
		if tt == html.ErrorToken {
			if err := flush(); err != nil {
				return err
			}
			if err := z.Err(); err != nil && err != io.EOF {
				return err
			}
			return nil
		}

		switch tt {
		case html.StartTagToken, html.SelfClosingTagToken:
			token := z.Token()
			tag := token.Data
			attrs := applyAttrRules(tag, token.Attr, &cfg)

			emitTag(&emitted, tt, tag, attrs)

			// Track <script> with rewritable content (no `src=`, no
			// non-JS `type=`, and not self-closing). The next text token
			// is the script body — pipe it through the JS rewriter.
			if tt == html.StartTagToken && tag == "script" && cfg.RewriteInlineJS != nil {
				inScript = isJSScript(attrs)
			}
			// Same idea for <style> — the body is CSS.
			if tt == html.StartTagToken && tag == "style" && cfg.RewriteInlineCSS != nil {
				inStyle = true
			}
			// <noscript> content is emitted by the tokenizer as a single raw
			// text token (the tokenizer assumes scripting is enabled). We need
			// to re-parse and rewrite it ourselves.
			if tt == html.StartTagToken && tag == "noscript" {
				inNoscript = true
			}

			// Inject the bootstrap chain immediately after <head> opens,
			// so it runs before any other inline script in the document.
			if !bootstrapDone && (tag == "head" || tag == "body") {
				if cfg.ChallengePathPrefix != "" {
					emitRaw([]byte(challengePathFixScript(cfg.ChallengePathPrefix, cfg.ChallengeCookiePrefix, cfg.ChallengeDebug)))
				}
				if cfg.InjectBootstrap {
					emitRaw([]byte(bootstrapScript(&cfg)))
				}
				bootstrapDone = true
			}

		case html.EndTagToken:
			tn, _ := z.TagName()
			fmt.Fprintf(&emitted, "</%s>", string(tn))
			switch string(tn) {
			case "script":
				inScript = false
			case "style":
				inStyle = false
			case "noscript":
				inNoscript = false
			}

		case html.TextToken:
			switch {
			case inScript && cfg.RewriteInlineJS != nil:
				// CRITICAL: copy z.Text() before handing it to the JS rewriter.
				// z.Text() returns a slice that aliases the html tokenizer's
				// internal buffer; tdewolff/parse.NewInputBytes (used inside
				// jsrewrite.Rewrite) writes a NUL sentinel one byte past the
				// end of its input. Without a copy, that NUL stomps the first
				// byte of the next tag in the tokenizer's buffer (typically
				// the `<` of `</script>`), producing `\0/script>` in output.
				emitRaw(cfg.RewriteInlineJS(append([]byte(nil), z.Text()...)))
			case inStyle && cfg.RewriteInlineCSS != nil:
				// Same NUL-sentinel concern for the CSS rewriter (also uses
				// tdewolff/parse) — copy defensively.
				emitRaw(cfg.RewriteInlineCSS(append([]byte(nil), z.Text()...)))
			case inNoscript:
				// The tokenizer emits the entire content of <noscript> as one
				// raw text token (it assumes scripting is enabled). Re-parse it
				// as an HTML fragment so its URL-bearing attributes get rewritten.
				fragCfg := cfg
				fragCfg.InjectBootstrap = false
				var fragBuf bytes.Buffer
				if err := Rewrite(&fragBuf, bytes.NewReader(z.Raw()), fragCfg); err == nil {
					emitRaw(fragBuf.Bytes())
				} else {
					emitRaw(z.Raw())
				}
			default:
				emitRaw(z.Raw())
			}

		case html.CommentToken, html.DoctypeToken:
			emitRaw(z.Raw())
		}

		// Periodic flush to keep memory bounded on very long documents.
		// 64KB is large enough that we don't TCP-thrash on small docs and
		// small enough that streamed pages don't buffer pathologically.
		if emitted.Len() > 64*1024 {
			if err := flush(); err != nil {
				return err
			}
		}
	}
}

// applyAttrRules is the per-tag rule pipeline. Each rule mutates the attrs
// slice in place where applicable and the returned slice is the final set.
// Order is significant — meta-stripping has to come before any rule that
// might emit a <meta> of its own (none currently do, but preserve the
// invariant). cfg is by pointer so HTML_BASETAG can shift BaseURL for
// subsequent tags in the same document.
func applyAttrRules(tag string, attrs []html.Attribute, cfg *Config) []html.Attribute {
	rewriteOne := func(raw string, opts urlOpts) string {
		_ = opts // reserved for future ?r=1, ?ct=js, ?doc=1 query-suffix support
		return urlrewrite.Rewrite(raw, cfg.BaseURL, cfg.Proxy)
	}

	// HTML_BASETAG — <base href> updates the in-flight base URL so all
	// downstream tags resolve relatives against the new origin.
	if tag == "base" {
		if v, ok := getAttr(attrs, "href"); ok {
			if u, err := url.Parse(v); err == nil {
				if cfg.BaseURL == nil {
					cfg.BaseURL = u
				} else {
					cfg.BaseURL = cfg.BaseURL.ResolveReference(u)
				}
			}
		}
	}

	// HTML_METATAG — drop <meta http-equiv="content-security-policy"> so
	// the origin's CSP doesn't block our injected /rewriter.js.
	if tag == "meta" {
		if eq, ok := getAttr(attrs, "http-equiv"); ok && strings.EqualFold(eq, "content-security-policy") {
			attrs = removeAttr(attrs, "content")
			attrs = removeAttr(attrs, "http-equiv")
		}
	}

	// HTML_INTEGRITY — we mutate <script>/<link> bodies so subresource
	// integrity hashes will never match. Drop the attr.
	attrs = removeAttr(attrs, "integrity")

	// HTML_CROSSORIGIN — force `use-credentials` so cookies follow the
	// rewritten request. Skip <link rel="preload"> — the preload's credentials
	// mode must match whatever the actual JS fetch uses; we can't know that
	// statically, and mismatching causes the preload to be silently discarded.
	if _, ok := getAttr(attrs, "crossorigin"); ok {
		rel, _ := getAttr(attrs, "rel")
		if !(tag == "link" && strings.EqualFold(rel, "preload")) {
			attrs = setAttr(attrs, "crossorigin", "use-credentials")
		}
	}

	// HTML_SANDBOX on <iframe> — ensure allow-same-origin so the
	// nested document can talk to its parent's $rewriter.
	if tag == "iframe" {
		if v, ok := getAttr(attrs, "sandbox"); ok && !strings.Contains(v, "allow-same-origin") {
			next := strings.TrimSpace(v + " allow-same-origin")
			attrs = setAttr(attrs, "sandbox", next)
		}
	}

	// HTML_SRCSET — comma-separated URL list with descriptors.
	if (tag == "img" || tag == "source") {
		if v, ok := getAttr(attrs, "srcset"); ok {
			attrs = setAttr(attrs, "srcset",
				rewriteSrcset(v, func(u string) string { return rewriteOne(u, urlOpts{}) }))
		}
	}

	// HTML_STYLE — inline `style="..."` is a declaration list, not a full
	// stylesheet. The CSS rewriter is grammar-tolerant enough to handle a
	// raw declaration block (it just sees the same url()/string tokens).
	if cfg.RewriteInlineCSS != nil {
		if v, ok := getAttr(attrs, "style"); ok {
			attrs = setAttr(attrs, "style", string(cfg.RewriteInlineCSS([]byte(v))))
		}
	}

	// HTML_EXTERNAL_RESOURCE_ATTRS — the main URL containment loop.
	if attrList, ok := externalResourceAttrs[tag]; ok {
		for _, a := range attrList {
			v, exists := getAttr(attrs, a)
			if !exists {
				continue
			}
			rewritten := rewriteOne(v, urlOpts{tag: tag, attr: a})
			attrs = setAttr(attrs, a, rewritten)
		}
	}

	// HTML_PROCESS_SERVER_COOKIES — script/iframe loads sync cookies on done.
	// Only when the bootstrap is injected — $rewriter doesn't exist otherwise.
	if cfg.InjectBootstrap && (tag == "script" || tag == "iframe") {
		if _, ok := getAttr(attrs, "src"); ok {
			cur, _ := getAttr(attrs, "onload")
			if !strings.Contains(cur, "$rewriter.process_server_cookies()") {
				attrs = setAttr(attrs, "onload", "$rewriter.process_server_cookies();"+cur)
			}
		}
	}
	// HTML_IFRAME_INJECTION — inject the rewriter runtime into child iframes.
	// Called on load so that both proxy-served iframes (which already have
	// bootstrap injected by the HTML rewriter) and about:blank / document.write
	// iframes (which don't) get $rewriter in their window.
	if cfg.InjectBootstrap && tag == "iframe" {
		if _, ok := getAttr(attrs, "src"); ok {
			cur, _ := getAttr(attrs, "onload")
			if !strings.Contains(cur, "$rewriter.append_rewrite_script_into_iframe") {
				attrs = setAttr(attrs, "onload", cur+"$rewriter.append_rewrite_script_into_iframe(this);")
			}
		}
	}
	// HTML_FETCH_COOKIES — img loads sync cross-origin cookies on done.
	if cfg.InjectBootstrap && tag == "img" {
		if _, ok := getAttr(attrs, "src"); ok {
			cur, _ := getAttr(attrs, "onload")
			if !strings.Contains(cur, "$rewriter.fetch_cookies") {
				if cur == "" {
					attrs = setAttr(attrs, "onload", "$rewriter.fetch_cookies(this);")
				} else {
					attrs = setAttr(attrs, "onload", fmt.Sprintf("$rewriter.fetch_cookies(this, () => {;%s});", cur))
				}
			}
		}
	}

	return attrs
}

// urlOpts carries per-tag context for future handling (e.g. REST-form targets).
type urlOpts struct {
	tag  string
	attr string
}

// emitTag re-renders a token (with possibly mutated attrs) into the buffer.
// We don't use html.Token.String() so we have control over quoting and the
// trailing space-slash on void elements.
func emitTag(w io.Writer, kind html.TokenType, tag string, attrs []html.Attribute) {
	fmt.Fprintf(w, "<%s", tag)
	for _, a := range attrs {
		key := a.Key
		if a.Namespace != "" {
			key = a.Namespace + ":" + key
		}
		fmt.Fprintf(w, ` %s="%s"`, key, escapeAttr(a.Val))
	}
	if kind == html.SelfClosingTagToken {
		fmt.Fprint(w, " />")
	} else {
		fmt.Fprint(w, ">")
	}
}

// escapeAttr does the minimal escaping required for double-quoted HTML
// attribute values: & and " (and < to be safe in some contexts).
// Matches html.EscapeString's attr-safe subset.
func escapeAttr(s string) string {
	if !strings.ContainsAny(s, `&"<`) {
		return s
	}
	r := strings.NewReplacer(
		"&", "&amp;",
		`"`, "&#34;",
		"<", "&lt;",
	)
	return r.Replace(s)
}

// getAttr returns the value (and presence flag) for `key` in attrs. Case-
// insensitive on the key, matching how browsers treat attribute names.
func getAttr(attrs []html.Attribute, key string) (string, bool) {
	for _, a := range attrs {
		if strings.EqualFold(a.Key, key) {
			return a.Val, true
		}
	}
	return "", false
}

// setAttr returns attrs with key=val. Replaces the existing entry if any.
func setAttr(attrs []html.Attribute, key, val string) []html.Attribute {
	for i, a := range attrs {
		if strings.EqualFold(a.Key, key) {
			attrs[i].Val = val
			return attrs
		}
	}
	return append(attrs, html.Attribute{Key: key, Val: val})
}

// removeAttr returns attrs with the named entry stripped.
func removeAttr(attrs []html.Attribute, key string) []html.Attribute {
	out := attrs[:0]
	for _, a := range attrs {
		if !strings.EqualFold(a.Key, key) {
			out = append(out, a)
		}
	}
	return out
}

// jsMimeTypes is the set of <script type="..."> values whose content is JS.
// Empty/missing type is also treated as JS by default.
var jsMimeTypes = map[string]bool{
	"application/ecmascript":  true,
	"application/javascript":  true,
	"application/x-ecmascript": true,
	"application/x-javascript": true,
	"text/ecmascript":  true,
	"text/javascript":  true,
	"text/javascript1.0": true,
	"text/javascript1.1": true,
	"text/javascript1.2": true,
	"text/javascript1.3": true,
	"text/javascript1.4": true,
	"text/javascript1.5": true,
	"text/jscript":      true,
	"text/livescript":   true,
	"text/x-ecmascript": true,
	"text/x-javascript": true,
	"module":            true,
}

// isJSScript reports whether a <script> tag's body should be processed by
// the JS rewriter. False for tags with src= (external — the body is empty
// anyway) or non-JS type= values (template, JSON, etc.).
func isJSScript(attrs []html.Attribute) bool {
	if _, has := getAttr(attrs, "src"); has {
		return false
	}
	t, has := getAttr(attrs, "type")
	if !has || t == "" {
		return true
	}
	return jsMimeTypes[strings.ToLower(strings.TrimSpace(t))]
}
