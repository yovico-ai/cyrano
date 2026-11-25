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
	st := newTokenStream(r)
	z := st.z
	bootstrapDone := false // guard against multiple <head> (e.g. nested srcdoc)
	inScript := false      // currently inside <script>...</script> with rewritable content
	inImportMap := false   // currently inside <script type="importmap">
	inStyle := false       // currently inside <style>...</style>
	inNoscript := false    // currently inside <noscript>...</noscript>
	foreignText := false   // the script/style is SVG's: its text is markup text (entities decoded)
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
	// A <style> start tag waits for its text: when the rewriter changes
	// the text, the tag carries the text as written (OriginalsAttr "#text"),
	// so the page reads its own CSS back (React's hydration compares a
	// <style>'s textContent with what it renders: 21kschool.com).
	type heldTag struct {
		tt    html.TokenType
		tag   string
		attrs []html.Attribute
	}
	var held *heldTag
	release := func(was, now []byte) {
		if held == nil {
			return
		}
		attrs := held.attrs
		if was != nil && !bytes.Equal(was, now) && !cfg.NoOriginals {
			attrs = withTextOriginal(attrs, string(was))
		}
		emitTag(&emitted, held.tt, held.tag, attrs)
		held = nil
	}

	for {
		tt := z.Next()
		if held != nil && !(tt == html.TextToken && inStyle) {
			release(nil, nil)
		}
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
			raw := append([]byte(nil), z.Raw()...)
			token := z.Token()
			tag := token.Data
			written := append([]html.Attribute(nil), token.Attr...)
			elNs := st.startTag(token, tt == html.SelfClosingTagToken)
			attrs := applyAttrRules(tag, elNs == NsSVG, token.Attr, &cfg)
			if !cfg.NoOriginals {
				attrs = withOriginals(written, attrs)
			}

			// The bootstrap: after the first <head> or <body>, or before
			// the first element of any other name (a fragment-like page,
			// common in ad frames) — before every script of the page
			// (spec/HtmlTok.agda bootstrapAt).
			before, after := bootstrapPlace(tag)
			if !bootstrapDone && before {
				if cfg.InjectBootstrap {
					emitRaw([]byte(bootstrapScript(&cfg)))
				}
				bootstrapDone = true
			}

			if tt == html.StartTagToken && tag == "style" && cfg.RewriteInlineCSS != nil {
				held = &heldTag{tt, tag, attrs}
			} else if sameAttrs(attrs, written) {
				// Nothing to change: the tag as written, byte for byte — its
				// line breaks (script line numbers below it), its attributes'
				// text and encoding (a legacy-encoded page's references).
				emitRaw(raw)
			} else {
				emitTag(&emitted, tt, tag, attrs)
			}

			// Track <script> with rewritable content (no `src=`, no
			// non-JS `type=`, and not self-closing). The next text token
			// is the script body — pipe it through the JS rewriter.
			if tt == html.StartTagToken && tag == "script" && cfg.RewriteInlineJS != nil {
				inScript = isJSScript(attrs)
				foreignText = elNs != NsHTML
			}
			// An import map: JSON whose URLs must match the proxified module
			// specifiers.
			if tt == html.StartTagToken && tag == "script" {
				_, hasSrc := getAttr(attrs, "src")
				inImportMap = elNs == NsHTML && !hasSrc && scriptKindOf(attrs) == ScriptImportMap
			}
			// Same idea for <style> — the body is CSS.
			if tt == html.StartTagToken && tag == "style" && cfg.RewriteInlineCSS != nil {
				inStyle = true
				foreignText = elNs != NsHTML
			}
			// <noscript> content is emitted by the tokenizer as a single raw
			// text token (scripting is on): kept as written.
			if tt == html.StartTagToken && tag == "noscript" && elNs == NsHTML {
				inNoscript = true
			}

			if !bootstrapDone && after {
				if cfg.InjectBootstrap {
					emitRaw([]byte(bootstrapScript(&cfg)))
				}
				bootstrapDone = true
			}

		case html.EndTagToken:
			emitRaw(z.Raw()) // as written (an end tag's attributes, spelling, spaces)
			tn, _ := z.TagName()
			st.endTag(string(tn))
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
			case foreignText && (inScript && cfg.RewriteInlineJS != nil || inStyle && cfg.RewriteInlineCSS != nil):
				// An SVG <script> / <style>: its text is ordinary markup
				// text, character references decoded — the script is the
				// decoded text, written back escaped.
				was := []byte(z.Token().Data)
				var src []byte
				if inScript {
					src = cfg.RewriteInlineJS(append([]byte(nil), was...))
				} else {
					src = cfg.RewriteInlineCSS(append([]byte(nil), was...))
					release(was, src)
				}
				emitRaw([]byte(html.EscapeString(string(src))))
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
				was := append([]byte(nil), z.Text()...)
				now := cfg.RewriteInlineCSS(append([]byte(nil), was...))
				release(was, now)
				emitRaw(now)
			case inNoscript:
				// A <noscript>'s content is text to a page with scripting on
				// (the tokenizer reads it as one raw text token): the page's
				// own text, as written. Script that turns it into markup
				// (lazy loaders) hands it to innerHTML and the like, which
				// the runtime rewrites.
				emitRaw(z.Raw())
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
func applyAttrRules(tag string, svg bool, attrs []html.Attribute, cfg *Config) []html.Attribute {
	// crossorigin as the page wrote it: use-credentials marks the URL so
	// (spec Attrs.credDest; the rules below give every one use-credentials).
	coWritten, coHas := getAttr(attrs, "crossorigin")
	credentialed := !svg && coHas && strings.EqualFold(strings.TrimSpace(coWritten), "use-credentials")
	// An element's own referrer policy: its requests carry it in their
	// proxified URLs (urlrewrite.RewriteWithPolicy) and the browser is told
	// unsafe-url, so the proxy learns the page and applies the policy
	// (TS: patches/referrer-policy.ts). An invalid value is no policy.
	policy := elementReferrerPolicy(tag, attrs)
	if policy != "" {
		attrs = setAttr(attrs, "referrerpolicy", string(urlrewrite.UnsafeURL))
	}
	// A script's or stylesheet's URL says so (spec/Attrs.agda urlDest), for
	// the proxy to rewrite it as such whatever its Content-Type.
	rel, _ := getAttr(attrs, "rel")
	as, hasAs := getAttr(attrs, "as")
	// A <base href> is resolved against the document's URL (spec/Html.agda
	// documentBase), its own attribute too: not against the base it sets
	// below (multistate.us's <base href="../"> came out one level too high).
	preBase := cfg.BaseURL
	rewriteOne := func(raw string, opts urlOpts) string {
		dest := urlrewrite.CredDest(credentialed, URLDest(svg, tag, opts.attr, strings.Fields(strings.ToLower(rel)), strings.ToLower(as), hasAs))
		// An iframe sandboxed without allow-scripts runs nothing: its
		// document gets no runtime (spec Frames.frameDest).
		if dest == urlrewrite.DestFrame && tag == "iframe" && !svg {
			sandbox, has := getAttr(attrs, "sandbox")
			dest = urlrewrite.FrameDest(sandbox, has)
		}
		// A frame given a data: URL of a document: the document rewritten
		// as a srcdoc is, in a data: URL again (spec Frames.dataDocument).
		if (dest == urlrewrite.DestFrame || dest == urlrewrite.DestInert) && urlrewrite.DataDocKind(raw) != "" {
			return rewriteDataDocument(raw, cfg, dest == urlrewrite.DestInert)
		}
		base := cfg.BaseURL
		if tag == "base" && !svg {
			base = preBase
		}
		// In a legacy-encoded document the query is the browser's: in the
		// document's encoding (spec/Encoding.agda).
		return urlrewrite.Requery(urlrewrite.RewriteMarked(raw, base, cfg.Proxy, urlrewrite.Mark{Policy: policy, Dest: dest}), raw, cfg.QueryEncoder)
	}

	// HTML_BASETAG — <base href> updates the in-flight base URL so all
	// downstream tags resolve relatives against the new origin.
	// Only the first <base> with an href counts, parsed against the
	// document's URL (spec/Html.agda documentBase; urlrewrite.DocumentBase).
	if tag == "base" && !cfg.baseSeen {
		if v, ok := getAttr(attrs, "href"); ok {
			cfg.baseSeen = true
			if cfg.BaseURL != nil {
				cfg.BaseURL = urlrewrite.DocumentBase(cfg.BaseURL, v)
			}
		}
	}

	// HTML_METATAG — a <meta http-equiv="content-security-policy"> keeps
	// enforcing, translated for the proxy as a header policy is
	// (urlrewrite.RewriteCSP). The runtime is already in place above it.
	if tag == "meta" {
		if eq, ok := getAttr(attrs, "http-equiv"); ok && strings.EqualFold(strings.TrimSpace(eq), "content-security-policy") {
			if v, ok := getAttr(attrs, "content"); ok && cfg.OnMetaCSP != nil {
				cfg.OnMetaCSP(v)
			}
			if v, ok := getAttr(attrs, "content"); ok && cfg.Proxy.PublicURL != nil {
				attrs = setAttr(attrs, "content", urlrewrite.RewriteMetaCSP(v, cfg.Proxy.PublicURL.Scheme+"://"+cfg.Proxy.PublicURL.Host))
			}
		}
		// <meta name="referrer">: the page's Referrer-Policy. As with the
		// header (proxy.recordPagePolicy) the browser is told unsafe-url,
		// so the proxy always learns the requesting page, and applies the
		// page's own policy to what goes upstream.
		if n, ok := getAttr(attrs, "name"); ok && strings.EqualFold(strings.TrimSpace(n), "referrer") {
			if c, ok := getAttr(attrs, "content"); ok && cfg.OnReferrerPolicy != nil && cfg.OnReferrerPolicy(c) {
				attrs = setAttr(attrs, "content", "unsafe-url")
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
	// bug). Exceptions: a font preload stays in its original (anonymous)
	// credentials mode to match the @font-face fetch, which is not credentialed
	// — forcing it would instead double-fetch the font; a fetch preload stays
	// to match the page's own fetch(), whose credentials the runtime leaves.
	if _, ok := getAttr(attrs, "crossorigin"); ok {
		rel, _ := getAttr(attrs, "rel")
		as, _ := getAttr(attrs, "as")
		if v, set := crossoriginValue(!svg, tag, rel, as); set {
			attrs = setAttr(attrs, "crossorigin", v)
		}
	}

	// An iframe's sandbox is kept as written (spec/Attrs.agda): a sandboxed
	// frame without allow-same-origin has an opaque origin through the proxy
	// as directly — its runtime is its own, its requests reach the proxy.
	// allow-same-origin was added once: the parent then read the frame's
	// document, its messages came from a real origin, its cookies worked.

	// HTML_STYLE — inline `style="..."` is a declaration list, not a full
	// stylesheet. The CSS rewriter is grammar-tolerant enough to handle a
	// raw declaration block (it just sees the same url()/string tokens).
	if cfg.RewriteInlineCSS != nil {
		if v, ok := getAttr(attrs, "style"); ok {
			attrs = setAttr(attrs, "style", string(cfg.RewriteInlineCSS([]byte(v))))
		}
	}

	// <script src="data:…">: its text is JavaScript the rewriter never saw
	// (WordPress optimisers write inline scripts so): read as the browser
	// reads it and given a data: URL of the rewritten text (spec/DataUrl.agda;
	// TS patches/blob-document.ts dataScriptFor). The page reads its own
	// URL back (originals).
	if tag == "script" && !svg && cfg.RewriteDataScript != nil {
		if v, ok := getAttr(attrs, "src"); ok {
			if k := scriptKindOf(attrs); k == ScriptClassic || k == ScriptModule {
				if now := urlrewrite.RewriteDataScript(v, func(text string) string { return cfg.RewriteDataScript(v, text) }); now != v {
					attrs = setAttr(attrs, "src", now)
				}
			}
		}
	}

	// <iframe srcdoc>: a whole document in an attribute. It is rewritten
	// like any other — with the runtime first, since the frame's scripts
	// run as it is parsed. Its base URL is the page's.
	if tag == "iframe" {
		if v, ok := getAttr(attrs, "srcdoc"); ok {
			// The frame's document has its own referrer: this page's URL by
			// this page's policy (srcdocReferrer; it read "" — round J),
			// else left to the browser's value.
			sub := *cfg
			if _, has := sub.ClientPassthrough["referrer"]; has || cfg.SrcdocReferrer != nil {
				sub.ClientPassthrough = make(map[string]any, len(cfg.ClientPassthrough)+1)
				for k, v := range cfg.ClientPassthrough {
					if k != "referrer" {
						sub.ClientPassthrough[k] = v
					}
				}
				if cfg.SrcdocReferrer != nil {
					r, ok := cfg.SrcdocReferrer()
					if !ok {
						r = "" // none: document.referrer reads ""
					}
					sub.ClientPassthrough["referrer"] = r
				}
			}
			var doc bytes.Buffer
			if err := Rewrite(&doc, strings.NewReader(v), sub); err == nil {
				attrs = setAttr(attrs, "srcdoc", doc.String())
			}
		}
		// The allow attribute's origins name nothing on the proxy, where the
		// frame's src is a proxy URL: written 'src' (spec/Allow.agda).
		if v, ok := getAttr(attrs, "allow"); ok && !svg {
			if now := urlrewrite.RewriteAllow(v); now != v {
				attrs = setAttr(attrs, "allow", now)
			}
		}
	}

	// The URL-bearing attributes (spec/Attrs.agda attrKind): a URL, a URL
	// list, a srcset; reflected ones (cite, longdesc) stay as written.
	var anim *string
	if v, ok := getAttr(attrs, "attributename"); ok && svg {
		anim = &v
	}
	for _, at := range append([]html.Attribute(nil), attrs...) {
		key := at.Key
		if at.Namespace != "" {
			key = at.Namespace + ":" + key
		}
		one := func(u string) string { return rewriteOne(u, urlOpts{tag: tag, attr: key}) }
		switch URLAttrKindIn(svg, tag, key, anim) {
		case AttrURL:
			// A javascript: URL's code through the JS rules (spec/JsUrl.agda).
			if _, isJS := urlrewrite.JSURLCode(at.Val); isJS {
				if cfg.RewriteJSURL != nil {
					attrs = setAttr(attrs, key, urlrewrite.RewriteJSURL(at.Val, cfg.RewriteJSURL))
				}
				continue
			}
			attrs = setAttr(attrs, key, one(at.Val))
		case AttrAnimURLs:
			attrs = setAttr(attrs, key, RewriteAnimURLs(at.Val, one))
		case AttrURLList:
			attrs = setAttr(attrs, key, RewriteURLList(at.Val, one))
		case AttrSrcset:
			attrs = setAttr(attrs, key, rewriteSrcset(at.Val, one))
		case AttrCSS:
			if cfg.RewriteInlineCSS != nil {
				attrs = setAttr(attrs, key, string(cfg.RewriteInlineCSS([]byte(at.Val))))
			}
		case AttrHandler:
			// A function body, rewritten by the JS rules as an inline
			// script is (spec/Attrs.agda handler); read back as written.
			if cfg.RewriteInlineJS != nil {
				if now := string(cfg.RewriteInlineJS([]byte(at.Val))); now != at.Val {
					attrs = setAttr(attrs, key, now)
				}
			}
		}
	}

	return attrs
}

// urlOpts names the attribute a URL is in.
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

// ScriptKind is what a <script> is (spec/Html.agda scriptKind, checked
// against Chromium; TS: patches/dynamic-html.ts scriptKind).
type ScriptKind uint8

const (
	ScriptClassic ScriptKind = iota
	ScriptModule
	ScriptImportMap
	ScriptSpeculationRules
	ScriptData
)

// jsEssences are the JavaScript MIME type essence strings (MIME Sniffing §4.6).
var jsEssences = map[string]bool{
	"application/ecmascript": true, "application/javascript": true, "application/x-ecmascript": true,
	"application/x-javascript": true, "text/ecmascript": true, "text/javascript": true, "text/javascript1.0": true,
	"text/javascript1.1": true, "text/javascript1.2": true, "text/javascript1.3": true, "text/javascript1.4": true,
	"text/javascript1.5": true, "text/jscript": true, "text/livescript": true, "text/x-ecmascript": true,
	"text/x-javascript": true,
}

func asciiLowerHTML(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

func stripASCIIWS(s string) string { return strings.Trim(s, "\t\n\f\r ") }

// ScriptKindFor is the kind of a script with these type and language
// attributes (has*: the attribute is present).
func ScriptKindFor(hasType bool, typ string, hasLang bool, lang string) ScriptKind {
	switch {
	case hasType && typ == "", !hasType && hasLang && lang == "", !hasType && !hasLang:
		return ScriptClassic
	case !hasType:
		if jsEssences[asciiLowerHTML(stripASCIIWS("text/"+lang))] {
			return ScriptClassic
		}
		return ScriptData
	}
	switch l := asciiLowerHTML(typ); {
	case jsEssences[asciiLowerHTML(stripASCIIWS(typ))]:
		return ScriptClassic
	case l == "module":
		return ScriptModule
	case l == "importmap":
		return ScriptImportMap
	case l == "speculationrules":
		return ScriptSpeculationRules
	}
	return ScriptData
}

func scriptKindOf(attrs []html.Attribute) ScriptKind {
	t, hasType := getAttr(attrs, "type")
	l, hasLang := getAttr(attrs, "language")
	return ScriptKindFor(hasType, t, hasLang, l)
}

// isJSScript reports whether a <script> tag's body is JavaScript to
// rewrite: an inline classic or module script.
func isJSScript(attrs []html.Attribute) bool {
	if _, has := getAttr(attrs, "src"); has {
		return false
	}
	k := scriptKindOf(attrs)
	return k == ScriptClassic || k == ScriptModule
}

// referrerPolicyTags are the elements with a referrerpolicy attribute.
var referrerPolicyTags = map[string]bool{"a": true, "area": true, "img": true, "iframe": true, "link": true, "script": true}

// elementReferrerPolicy is the referrer policy an element's referrerpolicy
// attribute states (an enumerated attribute: ASCII case-insensitive), or ""
// for none or an invalid value.
func elementReferrerPolicy(tag string, attrs []html.Attribute) urlrewrite.Policy {
	if !referrerPolicyTags[tag] {
		return ""
	}
	v, ok := getAttr(attrs, "referrerpolicy")
	if !ok {
		return ""
	}
	return urlrewrite.ReferrerPolicyToken(v)
}

// OriginalsAttr carries, on an element of rewritten HTML, the text of each
// attribute as the page wrote it, for those cyrano changed: a JSON object
// of name → value, or null for an attribute the page did not have. The
// client runtime reads it into its store and removes it before any page
// script runs (ts/client/src/native/originals.ts), so getAttribute,
// outerHTML and the rest show the page its own markup.
const OriginalsAttr = "crn-o"

// withTextOriginal adds to OriginalsAttr the element's text as written,
// under "#text" (no attribute has that name): the client records it for
// the element's text node (ts/client/src/native/originals.ts consume).
func withTextOriginal(attrs []html.Attribute, was string) []html.Attribute {
	enc, _ := json.Marshal(was)
	for i, a := range attrs {
		if a.Namespace == "" && a.Key == OriginalsAttr && strings.HasSuffix(a.Val, "}") {
			out := append([]html.Attribute(nil), attrs...)
			out[i].Val = strings.TrimSuffix(a.Val, "}") + `,"#text":` + string(enc) + "}"
			return out
		}
	}
	return append(append([]html.Attribute(nil), attrs...), html.Attribute{Key: OriginalsAttr, Val: `{"#text":` + string(enc) + "}"})
}

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

// crossoriginValue is the crossorigin written for an element
// (spec/Attrs.agda crossoriginValue): on an HTML element use-credentials,
// except a font or fetch preload or prefetch (matched to @font-face's and
// the page's own fetch's credentials); set false: as written. An SVG
// element's was forced too, where the runtime left it.
func crossoriginValue(html bool, tag, rel, as string) (string, bool) {
	if !html {
		return "", false
	}
	r := strings.ToLower(rel)
	if a := strings.ToLower(as); tag == "link" && (r == "preload" || r == "prefetch") && (a == "font" || a == "fetch") {
		return "", false
	}
	return "use-credentials", true
}

// sameAttrs: the rules left the attributes as the tokenizer read them.
func sameAttrs(a, b []html.Attribute) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// rewriteDataDocument is a frame's data: URL of a document with the
// document rewritten as a srcdoc is (spec Frames.dataDocument): its base its
// own URL (nothing relative resolves against it: such references stay as
// written, as directly), the runtime first — told the data: URL as its
// location, loaded from the proxy's origin (a data: document resolves no
// path) — but for an inert frame (sandboxed without scripts).
func rewriteDataDocument(raw string, cfg *Config, inert bool) string {
	own, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return raw
	}
	return urlrewrite.RewriteDataScript(raw, func(text string) string {
		sub := *cfg
		sub.BaseURL = own
		sub.baseSeen = false
		sub.InjectBootstrap = cfg.InjectBootstrap && !inert
		if cfg.Proxy.PublicURL != nil && strings.HasPrefix(cfg.RewriterJSPath, "/") {
			sub.RewriterJSPath = cfg.Proxy.PublicURL.Scheme + "://" + cfg.Proxy.PublicURL.Host + cfg.RewriterJSPath
		}
		if _, has := sub.ClientPassthrough["referrer"]; has {
			sub.ClientPassthrough = make(map[string]any, len(cfg.ClientPassthrough))
			for k, v := range cfg.ClientPassthrough {
				if k != "referrer" {
					sub.ClientPassthrough[k] = v
				}
			}
		}
		// An SVG / XHTML / XML one is rewritten as XML (spec Frames.dataDocKind).
		if urlrewrite.DataDocKind(raw) == "xml" {
			return string(RewriteXMLDocument([]byte(text), &sub))
		}
		var doc bytes.Buffer
		if err := Rewrite(&doc, strings.NewReader(text), sub); err != nil {
			return text
		}
		return doc.String()
	})
}
