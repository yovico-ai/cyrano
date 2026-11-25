package htmlrewrite

// An XML document the browser renders — SVG, XHTML, XML using those
// namespaces — rewritten in place (spec/XmlDoc.agda; Disposition.agda
// asXml). Every other byte stays as the origin sent it; a document that
// does not read as the spec reads it is returned unchanged.

import (
	"strconv"
	"strings"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// XMLRewriters rewrite the parts of an XML document (the server's
// rewriters; the oracle's stand-ins in conformance).
type XMLRewriters struct {
	URL     func(dest urlrewrite.Dest, v string) string // one URL, as an attribute of that destination
	URLs    func(string) string                         // a URL list (ping)
	Srcset  func(string) string
	CSSVal  func(string) string // a property's value (SVG presentation attributes)
	CSSDecl func(string) string // declarations (a style attribute)
	CSS     func(string) string // a style sheet
	JS      func(string) string // a script's text, a handler's body
	Sheet   func(string) string // a stylesheet's URL (xml-stylesheet)
}

// XMLNs is a root's namespace, for the bootstrap.
type XMLNs int

const (
	XMLOther XMLNs = iota
	XMLSvg
	XMLXhtml
)

const (
	svgURI   = "http://www.w3.org/2000/svg"
	xhtmlURI = "http://www.w3.org/1999/xhtml"
	xlinkURI = "http://www.w3.org/1999/xlink"
	xmlURI   = "http://www.w3.org/XML/1998/namespace"
)

type xattr struct {
	name, value string
	quote       byte
	from, to    int // the value's span, quotes included
}

type xkind int

const (
	xStart xkind = iota
	xEnd
	xText
	xCdata
	xComment
	xDoctype
	xPI
)

type xtok struct {
	kind     xkind
	name     string // a tag's name, a PI's target
	data     string // a PI's data
	attrs    []xattr
	empty    bool
	from, to int
}

func xmlWS(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

func xmlNameChar(c byte) bool {
	return !(xmlWS(c) || c == '/' || c == '>' || c == '=' || c == '<' || c == '"' || c == '\'' || c == '?' || c == '!' || c == '&')
}

// xmlTokenize is spec XmlDoc.tokenize.
func xmlTokenize(s string) ([]xtok, bool) {
	var out []xtok
	i := 0
	name := func(j int) int {
		for j < len(s) && xmlNameChar(s[j]) {
			j++
		}
		return j
	}
	skipWS := func(j int) int {
		for j < len(s) && xmlWS(s[j]) {
			j++
		}
		return j
	}
	for i < len(s) {
		if s[i] != '<' {
			j := strings.IndexByte(s[i:], '<')
			if j < 0 {
				j = len(s) - i
			}
			out = append(out, xtok{kind: xText, from: i, to: i + j})
			i += j
			continue
		}
		rest := s[i+1:]
		switch {
		case strings.HasPrefix(rest, "!--"):
			k := strings.Index(s[i+4:], "-->")
			if k < 0 {
				return nil, false
			}
			out = append(out, xtok{kind: xComment, from: i, to: i + 4 + k + 3})
			i += 4 + k + 3
		case strings.HasPrefix(rest, "![CDATA["):
			k := strings.Index(s[i+9:], "]]>")
			if k < 0 {
				return nil, false
			}
			out = append(out, xtok{kind: xCdata, from: i, to: i + 9 + k + 3})
			i += 9 + k + 3
		case strings.HasPrefix(rest, "!DOCTYPE"):
			j, depth := i+9, 0
			var q byte
			for ; j < len(s); j++ {
				c := s[j]
				if q != 0 {
					if c == q {
						q = 0
					}
					continue
				}
				if c == '"' || c == '\'' {
					q = c
				} else if c == '[' {
					depth++
				} else if c == ']' {
					if depth > 0 {
						depth--
					}
				} else if c == '>' && depth == 0 {
					break
				}
			}
			if j >= len(s) {
				return nil, false
			}
			out = append(out, xtok{kind: xDoctype, from: i, to: j + 1})
			i = j + 1
		case strings.HasPrefix(rest, "?"):
			n := name(i + 2)
			if n == i+2 {
				return nil, false
			}
			k := strings.Index(s[n:], "?>")
			if k < 0 {
				return nil, false
			}
			out = append(out, xtok{kind: xPI, name: s[i+2 : n], data: s[n : n+k], from: i, to: n + k + 2})
			i = n + k + 2
		case strings.HasPrefix(rest, "/"):
			n := name(i + 2)
			if n == i+2 {
				return nil, false
			}
			j := skipWS(n)
			if j >= len(s) || s[j] != '>' {
				return nil, false
			}
			out = append(out, xtok{kind: xEnd, name: s[i+2 : n], from: i, to: j + 1})
			i = j + 1
		default:
			n := name(i + 1)
			if n == i+1 {
				return nil, false
			}
			t := xtok{kind: xStart, name: s[i+1 : n], from: i}
			j := n
			for {
				k := skipWS(j)
				hadWS := k > j
				j = k
				if j >= len(s) {
					return nil, false
				}
				if s[j] == '>' {
					j++
					break
				}
				if s[j] == '/' {
					if j+1 < len(s) && s[j+1] == '>' {
						t.empty = true
						j += 2
						break
					}
					return nil, false
				}
				if !hadWS || !xmlNameChar(s[j]) {
					return nil, false
				}
				an := name(j)
				a := xattr{name: s[j:an]}
				j = skipWS(an)
				if j >= len(s) || s[j] != '=' {
					return nil, false
				}
				j = skipWS(j + 1)
				if j >= len(s) || (s[j] != '"' && s[j] != '\'') {
					return nil, false
				}
				a.quote, a.from = s[j], j
				e := j + 1
				for e < len(s) && s[e] != a.quote {
					if s[e] == '<' {
						return nil, false
					}
					e++
				}
				if e >= len(s) {
					return nil, false
				}
				a.value, a.to = s[j+1:e], e+1
				t.attrs = append(t.attrs, a)
				j = e + 1
			}
			t.to = j
			out = append(out, t)
			i = j
		}
	}
	return out, true
}

// xmlDecode is spec XmlDoc.decode: the predefined entities and character
// references; attr: a literal tab, CR or LF is a space.
func xmlDecode(s string, attr bool) (string, bool) {
	if !strings.ContainsAny(s, "&\t\r\n") {
		return s, true
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '&' {
			k := strings.IndexByte(s[i+1:], ';')
			if k < 0 {
				return "", false
			}
			r, ok := xmlEntity(s[i+1 : i+1+k])
			if !ok {
				return "", false
			}
			b.WriteRune(r)
			i += 1 + k
			continue
		}
		if attr && (c == '\t' || c == '\n' || c == '\r') {
			c = ' '
		}
		b.WriteByte(c)
	}
	return b.String(), true
}

func xmlEntity(n string) (rune, bool) {
	switch n {
	case "lt":
		return '<', true
	case "gt":
		return '>', true
	case "amp":
		return '&', true
	case "quot":
		return '"', true
	case "apos":
		return '\'', true
	}
	var v uint64
	var err error
	switch {
	case strings.HasPrefix(n, "#x") && len(n) > 2 && allHex(n[2:]):
		v, err = strconv.ParseUint(n[2:], 16, 32)
	case strings.HasPrefix(n, "#") && len(n) > 1 && allDigits(n[1:]):
		v, err = strconv.ParseUint(n[1:], 10, 32)
	default:
		return 0, false
	}
	if err != nil || v == 0 || v >= 0x110000 {
		return 0, false
	}
	return rune(v), true
}

func allHex(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

func allDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func xmlEncodeAttr(q byte, s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c == '&':
			b.WriteString("&amp;")
		case c == '<':
			b.WriteString("&lt;")
		case c == q && c == '"':
			b.WriteString("&quot;")
		case c == q:
			b.WriteString("&apos;")
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

func xmlEncodeText(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

func cdataSafe(s string) string { return strings.ReplaceAll(s, "]]>", "]]]]><![CDATA[>") }

func qname(n string) (prefix string, hasPrefix bool, local string) {
	if i := strings.IndexByte(n, ':'); i >= 0 {
		return n[:i], true, n[i+1:]
	}
	return "", false, n
}

type xbinding struct {
	prefix    string
	isDefault bool
	uri       string
}

func lookupNS(scope []xbinding, prefix string, isDefault bool) (string, bool) {
	for _, b := range scope {
		if b.isDefault == isDefault && (isDefault || b.prefix == prefix) {
			return b.uri, true
		}
	}
	return "", false
}

type xedit struct {
	from, to int
	text     string
}

type xopen struct {
	name  string
	scope []xbinding
	raw   int // 0: none, 1: CSS, 2: JS
}

// RewriteXML is spec XmlDoc.rewriteXml: the document rewritten, the
// bootstrap (bootFor of the root's namespace) placed; the document as sent
// when it does not read.
func RewriteXML(s string, rw XMLRewriters, bootFor func(XMLNs) string) string {
	toks, ok := xmlTokenize(s)
	if !ok {
		return s
	}
	var edits []xedit
	var stack []xopen
	rooted := false
	bootAt, bootNs := -1, XMLOther
	content := func(raw int, d string) string {
		if raw == 2 {
			return rw.JS(d)
		}
		return rw.CSS(d)
	}
	for _, t := range toks {
		var top *xopen
		if len(stack) > 0 {
			top = &stack[len(stack)-1]
		}
		switch t.kind {
		case xText:
			if top == nil || top.raw == 0 {
				continue
			}
			d, ok := xmlDecode(s[t.from:t.to], false)
			if !ok {
				return s
			}
			if now := content(top.raw, d); now != d {
				edits = append(edits, xedit{t.from, t.to, xmlEncodeText(now)})
			}
		case xCdata:
			if top == nil || top.raw == 0 {
				continue
			}
			d := s[t.from+9 : t.to-3]
			if now := content(top.raw, d); now != d {
				edits = append(edits, xedit{t.from + 9, t.to - 3, cdataSafe(now)})
			}
		case xPI:
			if !rooted {
				if e, ok := xmlStylesheetEdit(rw, t); ok {
					edits = append(edits, e)
				}
			}
		case xEnd:
			if top == nil || top.name != t.name {
				return s
			}
			stack = stack[:len(stack)-1]
		case xStart:
			var bind []xbinding
			for _, a := range t.attrs {
				p, hp, l := qname(a.name)
				u, ok := xmlDecode(a.value, true)
				if !ok {
					return s
				}
				if !hp && l == "xmlns" {
					bind = append(bind, xbinding{isDefault: true, uri: u})
				} else if hp && p == "xmlns" {
					bind = append(bind, xbinding{prefix: l, uri: u})
				}
			}
			var outer []xbinding
			if top != nil {
				outer = top.scope
			}
			scope := append(bind, outer...)
			p, hp, l := qname(t.name)
			var uri string
			switch {
			case !hp:
				uri, _ = lookupNS(scope, "", true)
			case p == "xml":
				uri = xmlURI
			default:
				u, ok := lookupNS(scope, p, false)
				if !ok {
					return s
				}
				uri = u
			}
			ns := XMLOther
			if uri == svgURI {
				ns = XMLSvg
			} else if uri == xhtmlURI {
				ns = XMLXhtml
			}
			local := strings.ToLower(l)
			if ns != XMLOther {
				es, was, ok := xmlAttrEdits(rw, ns == XMLSvg, local, t.attrs, scope)
				if !ok {
					return s
				}
				edits = append(edits, es...)
				// The changed attributes' originals, for read-back (spec originals).
				if len(was) > 0 {
					at := t.to - 1
					if t.empty {
						at = t.to - 2
					}
					edits = append(edits, xedit{at, at, ` ` + OriginalsAttr + `="` + xmlEncodeAttr('"', xmlJSONObject(was)) + `"`})
				}
			}
			if !rooted && !t.empty && ns != XMLOther {
				bootAt, bootNs = t.to, ns
			}
			rooted = true
			if !t.empty {
				raw := 0
				if ns != XMLOther {
					if local == "style" {
						raw = 1
					} else if local == "script" {
						raw = 2
					}
				}
				stack = append(stack, xopen{name: t.name, scope: scope, raw: raw})
			}
		}
	}
	if len(stack) > 0 {
		return s
	}
	var b strings.Builder
	at := 0
	booted := bootAt < 0
	emitBoot := func() {
		if !booted {
			booted = true
			b.WriteString(bootFor(bootNs))
		}
	}
	for _, e := range edits {
		if !booted && bootAt <= e.from {
			b.WriteString(s[at:bootAt])
			at = bootAt
			emitBoot()
		}
		b.WriteString(s[at:e.from])
		b.WriteString(e.text)
		at = e.to
	}
	if !booted {
		b.WriteString(s[at:bootAt])
		at = bootAt
		emitBoot()
	}
	b.WriteString(s[at:])
	return b.String()
}

// xmlJSONObject is spec jsonObject: names and values as JSON strings,
// '"', '\' and controls escaped (\u00xx), nothing else.
func xmlJSONObject(was [][2]string) string {
	str := func(b *strings.Builder, s string) {
		b.WriteByte('"')
		for i := 0; i < len(s); i++ {
			switch c := s[i]; {
			case c == '"':
				b.WriteString(`\"`)
			case c == '\\':
				b.WriteString(`\\`)
			case c < 0x20:
				b.WriteString(`\u00`)
				b.WriteByte("0123456789abcdef"[c>>4])
				b.WriteByte("0123456789abcdef"[c&15])
			default:
				b.WriteByte(c)
			}
		}
		b.WriteByte('"')
	}
	var b strings.Builder
	b.WriteByte('{')
	for i, nv := range was {
		if i > 0 {
			b.WriteByte(',')
		}
		str(&b, nv[0])
		b.WriteByte(':')
		str(&b, nv[1])
	}
	b.WriteByte('}')
	return b.String()
}

func xmlAttrEdits(rw XMLRewriters, svg bool, tag string, attrs []xattr, scope []xbinding) ([]xedit, [][2]string, bool) {
	decodedOf := func(name string) (string, bool) {
		for _, a := range attrs {
			if a.name == name {
				d, ok := xmlDecode(a.value, true)
				return d, ok
			}
		}
		return "", false
	}
	var out []xedit
	var was [][2]string
	for _, a := range attrs {
		p, hp, l := qname(a.name)
		d, ok := xmlDecode(a.value, true)
		if !ok {
			return nil, nil, false
		}
		key := l
		if hp {
			if u, ok := lookupNS(scope, p, false); ok && u == xlinkURI && l == "href" {
				key = "xlink:href"
			} else {
				key = p + ":" + l
			}
		}
		var now string
		var anim *string
		if v, ok := decodedOf("attributeName"); ok {
			anim = &v
		}
		switch URLAttrKindIn(svg, tag, key, anim) {
		case AttrURL:
			rel, _ := decodedOf("rel")
			as, hasAs := decodedOf("as")
			co, coHas := decodedOf("crossorigin")
			now = rw.URL(urlrewrite.CredDest(!svg && coHas && strings.EqualFold(strings.TrimSpace(co), "use-credentials"),
				URLDest(svg, tag, key, strings.Fields(strings.ToLower(rel)), strings.ToLower(as), hasAs)), d)
		case AttrAnimURLs:
			now = RewriteAnimURLs(d, func(u string) string { return rw.URL("", u) })
		case AttrURLList:
			now = rw.URLs(d)
		case AttrSrcset:
			now = rw.Srcset(d)
		case AttrCSS:
			now = rw.CSSVal(d)
		case AttrHandler:
			now = rw.JS(d)
		case AttrReflected:
			now = d
		default:
			if key == "style" {
				now = rw.CSSDecl(d)
			} else {
				now = d
			}
		}
		if now != d {
			out = append(out, xedit{a.from, a.to, string(a.quote) + xmlEncodeAttr(a.quote, now) + string(a.quote)})
			was = append(was, [2]string{a.name, d})
		}
	}
	return out, was, true
}

// xmlStylesheetEdit: an <?xml-stylesheet href="…"?>'s href, a stylesheet's URL.
func xmlStylesheetEdit(rw XMLRewriters, t xtok) (xedit, bool) {
	if t.name != "xml-stylesheet" {
		return xedit{}, false
	}
	base := t.from + 2 + len(t.name)
	d := t.data
	for k := 0; k+6 <= len(d); {
		if !strings.HasPrefix(d[k:], "href=") {
			k++
			continue
		}
		q := d[k+5]
		if q != '"' && q != '\'' {
			k += 6 // as the spec: past "href=" and the character after it
			continue
		}
		n := strings.IndexByte(d[k+6:], q)
		if n < 0 {
			return xedit{}, false
		}
		u, ok := xmlDecode(d[k+6:k+6+n], true)
		if !ok {
			return xedit{}, false
		}
		now := rw.Sheet(u)
		if now == u {
			return xedit{}, false
		}
		return xedit{base + k + 5, base + k + 6 + n + 1, string(q) + xmlEncodeAttr(q, now) + string(q)}, true
	}
	return xedit{}, false
}

// XMLBootstrap is the bootstrap for an XML document whose root is in the
// SVG or XHTML namespace (spec XmlDoc bootstrapAt): the HTML bootstrap's
// two steps as script elements of the root's namespace, the second's text
// in a CDATA section; both leave the document once they have run.
func XMLBootstrap(cfg *Config, ns XMLNs) string {
	uri, srcAttr, closeExternal := svgURI, "href", "/>"
	if ns == XMLXhtml {
		uri, srcAttr, closeExternal = xhtmlURI, "src", "></script>"
	} else if ns != XMLSvg {
		return ""
	}
	configJSON, err := asciiJSON(cfg.ClientPassthrough)
	if err != nil {
		configJSON = []byte(`{}`)
	}
	nonce := ""
	if cfg.ScriptNonce != "" {
		nonce = ` nonce="` + xmlEncodeAttr('"', cfg.ScriptNonce) + `"`
	}
	open := `<script xmlns="` + uri + `"` + nonce
	if cfg.ExternalBootstrap {
		boot := BootURL(configJSON, cfg.BaseURL)
		return open + ` ` + srcAttr + `="` + xmlEncodeAttr('"', cfg.RewriterJSPath) + `"` + closeExternal +
			open + ` ` + srcAttr + `="` + xmlEncodeAttr('"', boot) + `"` + closeExternal
	}
	init := FailClosed + `window.$rewriter=window.$rewriter_init(window,` + string(configJSON) + `).inject();` +
		`$rewriter.set_location(` + string(jsStringLiteral(cfg.BaseURL.String())) + `);` +
		`(function(s,p){p=s.previousElementSibling;if(p&&p.localName==="script")p.remove();s.remove()})(document.currentScript);`
	return open + ` ` + srcAttr + `="` + xmlEncodeAttr('"', cfg.RewriterJSPath) + `"` + closeExternal +
		open + `><![CDATA[` + cdataSafe(init) + `]]></script>`
}

// RewriteXMLDocument rewrites an XML document the browser renders, with
// the HTML rewriter's own rewriters (spec/XmlDoc.agda): URLs against the
// document's URL, marked by destination; CSS and JS by cfg's.
func RewriteXMLDocument(src []byte, cfg *Config) []byte {
	url := func(d urlrewrite.Dest, v string) string {
		return urlrewrite.RewriteMarked(v, cfg.BaseURL, cfg.Proxy, urlrewrite.Mark{Dest: d})
	}
	one := func(v string) string { return url("", v) }
	css := func(s string) string {
		if cfg.RewriteInlineCSS == nil {
			return s
		}
		return string(cfg.RewriteInlineCSS([]byte(s)))
	}
	js := func(s string) string {
		if cfg.RewriteInlineJS == nil {
			return s
		}
		return string(cfg.RewriteInlineJS([]byte(s)))
	}
	rw := XMLRewriters{
		URL:     url,
		URLs:    func(s string) string { return RewriteURLList(s, one) },
		Srcset:  func(s string) string { return rewriteSrcset(s, one) },
		CSSVal:  css,
		CSSDecl: css,
		CSS:     css,
		JS:      js,
		Sheet:   func(s string) string { return url(urlrewrite.DestStyle, s) },
	}
	boot := func(ns XMLNs) string {
		if !cfg.InjectBootstrap {
			return ""
		}
		return XMLBootstrap(cfg, ns)
	}
	return []byte(RewriteXML(string(src), rw, boot))
}

// XSLType: an <?xml-stylesheet?>'s type Chromium takes as XSL (spec
// XmlDoc.xslType).
func XSLType(t string) bool {
	switch strings.ToLower(t) {
	case "text/xml", "text/xsl", "application/xml", "application/xhtml+xml", "application/rss+xml", "application/atom+xml":
		return true
	}
	return false
}

// XSLNetPolicy is the policy an XSLT-styled document is given (spec
// XmlDoc.xslNetPolicy): the transformation's output keeps it, and loads
// only through the proxy ('self').
const XSLNetPolicy = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:"

// XSLTStyled: the document has an <?xml-stylesheet?> of an XSL type.
func XSLTStyled(src []byte) bool {
	toks, ok := xmlTokenize(string(src))
	if !ok {
		return false
	}
	for _, t := range toks {
		if t.kind != xPI || t.name != "xml-stylesheet" {
			continue
		}
		d := t.data
		for k := 0; k+6 <= len(d); k++ {
			if !strings.HasPrefix(d[k:], "type=") {
				continue
			}
			q := d[k+5]
			if q != '"' && q != '\'' {
				continue
			}
			if n := strings.IndexByte(d[k+6:], q); n >= 0 && XSLType(d[k+6:k+6+n]) {
				return true
			}
		}
	}
	return false
}
