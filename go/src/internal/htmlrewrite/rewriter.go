package htmlrewrite

import (
	"bytes"
	"encoding/json"
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
	bootstrapDone := false // guard against multiple <head> (e.g. nested srcdoc)
	inScript := false      // currently inside <script>...</script> with rewritable content
	inImportMap := false   // currently inside <script type="importmap">
	inStyle := false       // currently inside <style>...</style>
	inNoscript := false    // currently inside <noscript>...</noscript>
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
			written := append([]html.Attribute(nil), token.Attr...)
			attrs := applyAttrRules(tag, token.Attr, &cfg)
			if !cfg.NoOriginals {
				attrs = withOriginals(written, attrs)
			}

			// A document with no <head> or <body> tag (a fragment-like page,
			// common in ad frames): the bootstrap goes before its first
			// element, so its scripts — rewritten to call $rewriter — find it.
			if !bootstrapDone && cfg.InjectBootstrap && tag != "html" && tag != "head" && tag != "body" {
				emitRaw([]byte(bootstrapScript(&cfg)))
				bootstrapDone = true
			}

			emitTag(&emitted, tt, tag, attrs)

			// Track <script> with rewritable content (no `src=`, no
			// non-JS `type=`, and not self-closing). The next text token
			// is the script body — pipe it through the JS rewriter.
			if tt == html.StartTagToken && tag == "script" && cfg.RewriteInlineJS != nil {
				inScript = isJSScript(attrs)
			}
			// An import map: JSON whose URLs must match the proxified module
			// specifiers.
			if tt == html.StartTagToken && tag == "script" {
				t, _ := getAttr(attrs, "type")
				_, hasSrc := getAttr(attrs, "src")
				inImportMap = !hasSrc && strings.EqualFold(strings.TrimSpace(t), "importmap")
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
				inImportMap = false
			case "style":
				inStyle = false
			case "noscript":
				inNoscript = false
			}

		case html.TextToken:
			switch {
			case inImportMap:
				emitRaw(urlrewrite.RewriteImportMap(append([]byte(nil), z.Text()...), cfg.BaseURL, cfg.Proxy))
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
				fragCfg.NoOriginals = true // inert text: nothing consumes them
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

	// HTML_METATAG — a <meta http-equiv="content-security-policy"> keeps
	// enforcing, translated for the proxy as a header policy is
	// (urlrewrite.RewriteCSP). The runtime is already in place above it.
	if tag == "meta" {
		if eq, ok := getAttr(attrs, "http-equiv"); ok && strings.EqualFold(strings.TrimSpace(eq), "content-security-policy") {
			if v, ok := getAttr(attrs, "content"); ok && cfg.Proxy.PublicURL != nil {
				attrs = setAttr(attrs, "content", urlrewrite.RewriteCSP(v, cfg.Proxy.PublicURL.Scheme+"://"+cfg.Proxy.PublicURL.Host))
			}
		}
		// A declarative refresh navigates like a link: through the proxy.
		if eq, ok := getAttr(attrs, "http-equiv"); ok && strings.EqualFold(strings.TrimSpace(eq), "refresh") {
			if c, ok := getAttr(attrs, "content"); ok && cfg.BaseURL != nil {
				attrs = setAttr(attrs, "content", urlrewrite.RewriteRefresh(c, cfg.BaseURL, cfg.Proxy))
			}
		}
	}

	// HTML_INTEGRITY — we mutate <script>/<link> bodies so subresource
	// integrity hashes will never match. Drop the attr.
	attrs = removeAttr(attrs, "integrity")

	// HTML_CROSSORIGIN — force `use-credentials` so cookies follow the
	// rewritten (now same-origin) request. This MUST be applied consistently to
	// a resource and its <link rel=preload>: cyrano forces <script> to
	// use-credentials, so a script preload left at "anonymous" has a different
	// credentials mode, the browser refuses to reuse it for the script, and the
	// bundle is fetched twice — the unused preload hangs and, under HTTP/2
	// coalescing, wedges the connection (the vendor.js/main.js pending-forever
	// bug). Exception: a font preload stays in its original (anonymous)
	// credentials mode to match the @font-face fetch, which is not credentialed
	// — forcing it would instead double-fetch the font.
	if _, ok := getAttr(attrs, "crossorigin"); ok {
		rel, _ := getAttr(attrs, "rel")
		as, _ := getAttr(attrs, "as")
		isFontPreload := tag == "link" &&
			(strings.EqualFold(rel, "preload") || strings.EqualFold(rel, "prefetch")) &&
			strings.EqualFold(as, "font")
		if !isFontPreload {
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

	// HTML_SRCSET — comma-separated URL list with descriptors: img and
	// source srcset, and a preload link's imagesrcset (TS: isSrcsetAttr).
	srcsetAttr := ""
	switch tag {
	case "img", "source":
		srcsetAttr = "srcset"
	case "link":
		srcsetAttr = "imagesrcset"
	}
	if srcsetAttr != "" {
		if v, ok := getAttr(attrs, srcsetAttr); ok {
			attrs = setAttr(attrs, srcsetAttr,
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

	// <iframe srcdoc>: a whole document in an attribute. It is rewritten
	// like any other — with the runtime first, since the frame's scripts
	// run as it is parsed. Its base URL is the page's.
	if tag == "iframe" {
		if v, ok := getAttr(attrs, "srcdoc"); ok {
			// The frame's document has its own referrer — this page's URL —
			// not this page's: left to the browser's value.
			sub := *cfg
			if _, has := sub.ClientPassthrough["referrer"]; has {
				sub.ClientPassthrough = make(map[string]any, len(cfg.ClientPassthrough))
				for k, v := range cfg.ClientPassthrough {
					if k != "referrer" {
						sub.ClientPassthrough[k] = v
					}
				}
			}
			var doc bytes.Buffer
			if err := Rewrite(&doc, strings.NewReader(v), sub); err == nil {
				attrs = setAttr(attrs, "srcdoc", doc.String())
			}
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
	"application/ecmascript":   true,
	"application/javascript":   true,
	"application/x-ecmascript": true,
	"application/x-javascript": true,
	"text/ecmascript":          true,
	"text/javascript":          true,
	"text/javascript1.0":       true,
	"text/javascript1.1":       true,
	"text/javascript1.2":       true,
	"text/javascript1.3":       true,
	"text/javascript1.4":       true,
	"text/javascript1.5":       true,
	"text/jscript":             true,
	"text/livescript":          true,
	"text/x-ecmascript":        true,
	"text/x-javascript":        true,
	"module":                   true,
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

// OriginalsAttr carries, on an element of rewritten HTML, the text of each
// attribute as the page wrote it, for those cyrano changed: a JSON object
// of name → value, or null for an attribute the page did not have. The
// client runtime reads it into its store and removes it before any page
// script runs (ts/client/src/native/originals.ts), so getAttribute,
// outerHTML and the rest show the page its own markup.
const OriginalsAttr = "crn-o"

// withOriginals appends OriginalsAttr to attrs when they differ from the
// attributes as written.
func withOriginals(written, attrs []html.Attribute) []html.Attribute {
	first := func(list []html.Attribute) (map[string]string, []string) {
		m := make(map[string]string, len(list))
		var order []string
		for _, a := range list {
			if a.Namespace != "" {
				continue
			}
			if _, dup := m[a.Key]; !dup {
				m[a.Key] = a.Val
				order = append(order, a.Key)
			}
		}
		return m, order
	}
	was, wasOrder := first(written)
	now, nowOrder := first(attrs)
	var b strings.Builder
	add := func(name string, val *string) {
		if b.Len() == 0 {
			b.WriteByte('{')
		} else {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(name)
		b.Write(k)
		b.WriteByte(':')
		if val == nil {
			b.WriteString("null")
		} else {
			v, _ := json.Marshal(*val)
			b.Write(v)
		}
	}
	for _, name := range wasOrder {
		if v, ok := now[name]; !ok || v != was[name] {
			w := was[name]
			add(name, &w)
		}
	}
	for _, name := range nowOrder {
		if _, ok := was[name]; !ok {
			add(name, nil)
		}
	}
	if b.Len() == 0 {
		return attrs
	}
	b.WriteByte('}')
	return append(attrs, html.Attribute{Key: OriginalsAttr, Val: b.String()})
}
