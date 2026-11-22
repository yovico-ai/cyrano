package htmlrewrite

import (
	"strings"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// AttrKind is what an attribute's value is to cyrano (spec/Attrs.agda;
// TS: ts/client/src/patches/url-attribute-map.ts urlAttrKind).
type AttrKind uint8

const (
	AttrNone      AttrKind = iota
	AttrURL                // fetched or navigated: proxified
	AttrURLList            // space-separated URLs (ping, attributionsrc): each proxified
	AttrSrcset             // a srcset
	AttrReflected          // never fetched; its IDL getter resolves it (cite, longdesc): kept
	AttrCSS                // an SVG presentation attribute taking a <url>: CSS, rewritten as a style attribute
	AttrHandler            // an event handler content attribute: a function body, JS-rewritten
)

func (k AttrKind) String() string {
	return [...]string{"none", "url", "urllist", "srcset", "reflected", "css", "handler"}[k]
}

// svgPresentationURLAttrs are the SVG presentation attributes that take a
// <url>, on any SVG element (spec/Attrs.agda cssValue): Google Charts'
// clip-path="url(<page URL>#id)" was, proxied, an external document.
var svgPresentationURLAttrs = map[string]bool{
	"clip-path": true, "cursor": true, "fill": true, "filter": true,
	"marker-start": true, "marker-mid": true, "marker-end": true, "mask": true, "stroke": true,
}

var htmlAttrKinds = map[string]map[string]AttrKind{}
var svgAttrKinds = map[string]map[string]AttrKind{}

func init() {
	add := func(m map[string]map[string]AttrKind, k AttrKind, attr string, tags ...string) {
		for _, t := range tags {
			if m[t] == nil {
				m[t] = map[string]AttrKind{}
			}
			m[t][attr] = k
		}
	}
	h := htmlAttrKinds
	add(h, AttrURL, "src", "audio", "embed", "frame", "iframe", "img", "input", "script", "source", "track", "video")
	// <base href> names the proxied directory: the browser then resolves the
	// page's relative URLs under it, and `base-uri 'self'` is met.
	add(h, AttrURL, "href", "a", "area", "base", "link")
	add(h, AttrURL, "action", "form")
	add(h, AttrURL, "formaction", "button", "input")
	add(h, AttrURL, "data", "object")
	add(h, AttrURL, "poster", "video")
	add(h, AttrURL, "background", "body", "table", "tbody", "td", "tfoot", "th", "thead", "tr")
	add(h, AttrURLList, "ping", "a", "area")
	add(h, AttrURLList, "attributionsrc", "a", "area", "img", "script")
	add(h, AttrSrcset, "srcset", "img", "source")
	add(h, AttrSrcset, "imagesrcset", "link")
	add(h, AttrReflected, "cite", "blockquote", "del", "ins", "q")
	add(h, AttrReflected, "longdesc", "frame", "iframe", "img")
	add(h, AttrReflected, "lowsrc", "img")
	add(h, AttrReflected, "codebase", "object")
	add(svgAttrKinds, AttrURL, "href", "a", "feimage", "image", "script", "use")
	add(svgAttrKinds, AttrURL, "xlink:href", "a", "feimage", "image", "script", "use")
}

// URLAttrKind is spec attrKind: the attribute (lowercase; xlink:href) of an
// element (lowercase local name) in the SVG namespace or HTML.
// URLDest is what an attribute's URL is requested for, when it is a
// script or a stylesheet (spec/Attrs.agda urlDest): rel the link types
// (lowercase), as the as attribute (lowercase; hasAs: present).
func URLDest(svg bool, tag, attr string, rel []string, as string, hasAs bool) urlrewrite.Dest {
	if svg {
		if tag == "script" && (attr == "href" || attr == "xlink:href") {
			return urlrewrite.DestScript
		}
		return ""
	}
	if tag == "script" && attr == "src" {
		return urlrewrite.DestScript
	}
	// The document a frame is given by the document that holds it.
	if attr == "src" && (tag == "iframe" || tag == "frame" || tag == "embed") || tag == "object" && attr == "data" {
		return urlrewrite.DestFrame
	}
	if tag != "link" || attr != "href" {
		return ""
	}
	has := func(r string) bool {
		for _, x := range rel {
			if x == r {
				return true
			}
		}
		return false
	}
	switch {
	case has("stylesheet"):
		return urlrewrite.DestStyle
	case has("modulepreload"):
		return urlrewrite.DestScript
	case has("preload") || has("prefetch"):
		if hasAs && as == "script" {
			return urlrewrite.DestScript
		}
		if hasAs && as == "style" {
			return urlrewrite.DestStyle
		}
	}
	return ""
}

func URLAttrKind(svg bool, tag, attr string) AttrKind {
	if IsHandlerAttr(attr) {
		return AttrHandler
	}
	if svg {
		if k := svgAttrKinds[tag][attr]; k != AttrNone {
			return k
		}
		if svgPresentationURLAttrs[attr] {
			return AttrCSS
		}
		return AttrNone
	}
	if tag == "image" { // the parser makes it an img
		tag = "img"
	}
	return htmlAttrKinds[tag][attr]
}

// RewriteURLList is spec rewriteUrlList: each token between ASCII
// whitespace rewritten, the whitespace as written.
func RewriteURLList(v string, rw func(string) string) string {
	var b strings.Builder
	start := -1
	for i := 0; i <= len(v); i++ {
		if i == len(v) || v[i] == '\t' || v[i] == '\n' || v[i] == '\f' || v[i] == '\r' || v[i] == ' ' {
			if start >= 0 {
				b.WriteString(rw(v[start:i]))
				start = -1
			}
			if i < len(v) {
				b.WriteByte(v[i])
			}
		} else if start < 0 {
			start = i
		}
	}
	return b.String()
}

// The namespace of each element, from a simplified tree construction over
// the token stream: spec/HtmlTok.agda (startT, endT), checked against
// Chromium (html-tok-vs-chromium). Svg and math open foreign content;
// SVG foreignObject / desc / title and MathML annotation-xml (encoding
// text/html or application/xhtml+xml) are HTML integration points, mi mo
// mn ms mtext MathML text integration points; a breakout tag in foreign
// content leaves it; an end tag pops to the nearest open element of its
// name (</p> and </br> leave foreign content first).
type Ns int

const (
	NsHTML Ns = iota
	NsSVG
	NsMath
)

func (n Ns) String() string {
	switch n {
	case NsSVG:
		return "svg"
	case NsMath:
		return "math"
	}
	return "html"
}

type ipKind int

const (
	noIP ipKind = iota
	htmlIP
	textIP
)

type nsEntry struct {
	tag string
	ns  Ns
	ip  ipKind
}

type nsTracker struct {
	open []nsEntry // the current node last
	// The form element pointer (spec HtmlTok formPointer): set when a
	// <form> is inserted, cleared by </form>; while it is set a <form>
	// start tag is ignored. Inside a <template> it is neither read nor set.
	formPointer bool
}

func (n *nsTracker) templateOpen() bool {
	for _, x := range n.open {
		if namedHTML(x, "template") {
			return true
		}
	}
	return false
}

// formIgnored: a <form> start tag the tree builder ignores — no element,
// nothing popped (spec formIgnored).
func (n *nsTracker) formIgnored(tag string) bool {
	return tag == "form" && !n.foreignFor(tag) && n.formPointer && !n.templateOpen()
}

func fieldSet(s string) map[string]bool {
	m := map[string]bool{}
	for _, t := range strings.Fields(s) {
		m[t] = true
	}
	return m
}

var (
	foreignBreakout = fieldSet("b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var")
	htmlVoid        = fieldSet("area base basefont bgsound br col embed frame hr img input keygen link meta param source track wbr")
)

func (n *nsTracker) top() (nsEntry, bool) {
	if len(n.open) == 0 {
		return nsEntry{}, false
	}
	return n.open[len(n.open)-1], true
}

// foreignFor: whether a start tag is processed by the rules for foreign content.
func (n *nsTracker) foreignFor(tag string) bool {
	e, ok := n.top()
	if !ok || e.ns == NsHTML {
		return false
	}
	switch e.ip {
	case htmlIP:
		return false
	case textIP:
		if tag != "mglyph" && tag != "malignmark" {
			return false
		}
	}
	return !(e.tag == "annotation-xml" && tag == "svg")
}

func (n *nsTracker) popForeign() {
	for len(n.open) > 0 {
		e := n.open[len(n.open)-1]
		if e.ns == NsHTML || e.ip != noIP {
			return
		}
		n.open = n.open[:len(n.open)-1]
	}
}

func htmlNsOf(tag string) Ns {
	switch tag {
	case "svg":
		return NsSVG
	case "math":
		return NsMath
	}
	return NsHTML
}

// start records a start tag and reports its element's namespace. attr
// gives the tag's attribute values (the first of each name).
func (n *nsTracker) start(tag string, selfClosing bool, attr func(string) (string, bool)) Ns {
	has := func(a string) bool { _, ok := attr(a); return ok }
	ns := htmlNsOf(tag)
	if n.foreignFor(tag) {
		if foreignBreakout[tag] || tag == "font" && (has("color") || has("face") || has("size")) {
			n.popForeign()
			ns = NsHTML
		} else {
			e, _ := n.top()
			ns = e.ns
		}
	}
	// In body, these start tags first close a p in button scope (spec
	// HtmlTok closesP).
	if ns == NsHTML && closesP[tag] {
		n.popUntil(func(x nsEntry) bool { return namedHTML(x, "p") }, func(x nsEntry) bool { return scopeBoundary(x) || namedHTML(x, "button") })
	}
	// In HTML, an <image> is an <img> (the tree builder renames it).
	el := tag
	if ns == NsHTML && tag == "image" {
		el = "img"
	}
	pushed := !htmlVoid[el]
	if ns != NsHTML {
		pushed = !selfClosing
	}
	if pushed {
		ip := noIP
		switch {
		case ns == NsSVG && (tag == "foreignobject" || tag == "desc" || tag == "title"):
			ip = htmlIP
		case ns == NsMath && (tag == "mi" || tag == "mo" || tag == "mn" || tag == "ms" || tag == "mtext"):
			ip = textIP
		case ns == NsMath && tag == "annotation-xml":
			if v, ok := attr("encoding"); ok {
				if l := strings.ToLower(v); l == "text/html" || l == "application/xhtml+xml" {
					ip = htmlIP
				}
			}
		}
		n.open = append(n.open, nsEntry{el, ns, ip})
	}
	if ns == NsHTML && tag == "form" && !n.templateOpen() {
		n.formPointer = true
	}
	return ns
}

// end records an end tag (spec endT): the tree builder's end-tag rules,
// as far as the stack goes.
func (n *nsTracker) end(tag string) {
	if e, ok := n.top(); ok && e.ns != NsHTML {
		if tag == "p" || tag == "br" {
			n.popForeign()
			n.htmlEnd(tag)
			return
		}
		// Foreign content: to the nearest foreign element of the name,
		// until an HTML element is reached.
		for k := len(n.open) - 1; k >= 0; k-- {
			x := n.open[k]
			if x.ns == NsHTML {
				break
			}
			if x.tag == tag {
				n.open = n.open[:k]
				return
			}
		}
	}
	n.htmlEnd(tag)
}

var (
	endHeadings   = fieldSet("h1 h2 h3 h4 h5 h6")
	endScoped     = fieldSet("address article aside blockquote button center details dialog dir div dl fieldset figcaption figure footer header hgroup listing main menu nav ol pre search section summary ul applet marquee object dd dt form")
	endTableParts = fieldSet("table tbody thead tfoot tr td th caption colgroup template select")
	formattingEl  = fieldSet("a b big code em font i nobr s small strike strong tt u")
	specialHTML   = fieldSet("address applet area article aside base basefont bgsound blockquote body br button caption center col colgroup dd details dir div dl dt embed fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe img input keygen li link listing main marquee menu meta nav noembed noframes noscript object ol p param plaintext pre script search section select source style summary table tbody td template textarea tfoot th thead title tr track ul wbr xmp")
	scopeHTML     = fieldSet("applet caption html table td th marquee object template")
	ipSVG         = fieldSet("foreignobject desc title")
	ipMath        = fieldSet("mi mo mn ms mtext annotation-xml")
)

func ipName(x nsEntry) bool {
	switch x.ns {
	case NsSVG:
		return ipSVG[x.tag]
	case NsMath:
		return ipMath[x.tag]
	}
	return false
}

// Start tags that close a p in button scope first ("in body"; table
// too, in no-quirks mode: not modelled).
var closesP = fieldSet("address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer header hgroup main menu nav ol p search section summary ul h1 h2 h3 h4 h5 h6 pre listing form plaintext hr xmp")

func namedHTML(x nsEntry, t string) bool { return x.ns == NsHTML && x.tag == t }
func specialEl(x nsEntry) bool {
	if x.ns == NsHTML {
		return specialHTML[x.tag]
	}
	return ipName(x)
}
func scopeBoundary(x nsEntry) bool {
	if x.ns == NsHTML {
		return scopeHTML[x.tag]
	}
	return ipName(x)
}

// popUntil pops through the first entry m picks (from the current node
// down), unless a boundary b comes first.
func (n *nsTracker) popUntil(m, b func(nsEntry) bool) {
	for k := len(n.open) - 1; k >= 0; k-- {
		x := n.open[k]
		if m(x) {
			n.open = n.open[:k]
			return
		}
		if b(x) {
			return
		}
	}
}

func (n *nsTracker) htmlEnd(t string) {
	named := func(x nsEntry) bool { return namedHTML(x, t) }
	switch {
	case t == "body" || t == "html" || t == "br":
	case t == "form" && !n.templateOpen():
		// By the form pointer: ignored when it is not set.
		if n.formPointer {
			n.popUntil(named, scopeBoundary)
			n.formPointer = false
		}
	case t == "p":
		n.popUntil(named, func(x nsEntry) bool { return scopeBoundary(x) || namedHTML(x, "button") })
	case t == "li":
		n.popUntil(named, func(x nsEntry) bool { return scopeBoundary(x) || namedHTML(x, "ol") || namedHTML(x, "ul") })
	case endHeadings[t]:
		n.popUntil(func(x nsEntry) bool { return x.ns == NsHTML && endHeadings[x.tag] }, scopeBoundary)
	case endScoped[t]:
		n.popUntil(named, scopeBoundary)
	case endTableParts[t]:
		n.popUntil(named, func(x nsEntry) bool { return namedHTML(x, "html") || namedHTML(x, "table") || namedHTML(x, "template") })
	case formattingEl[t]:
		n.adoption(t)
	default:
		n.popUntil(named, specialEl)
	}
}

// adoption: the adoption agency, as far as the stack goes (spec adoption).
func (n *nsTracker) adoption(t string) {
	for round := 0; round < 8; round++ {
		f := -1
		for k := len(n.open) - 1; k >= 0; k-- {
			if namedHTML(n.open[k], t) {
				f = k
				break
			}
		}
		if f < 0 {
			n.popUntil(func(x nsEntry) bool { return namedHTML(x, t) }, specialEl)
			return
		}
		for k := f + 1; k < len(n.open); k++ {
			if scopeBoundary(n.open[k]) {
				return
			}
		}
		fb := -1
		for k := f + 1; k < len(n.open); k++ {
			if specialEl(n.open[k]) {
				fb = k
				break
			}
		}
		if fb < 0 {
			n.open = n.open[:f]
			return
		}
		next := append([]nsEntry(nil), n.open[:f]...)
		for k := f + 1; k < fb; k++ {
			if x := n.open[k]; x.ns == NsHTML && formattingEl[x.tag] {
				next = append(next, x)
			}
		}
		next = append(next, n.open[fb], n.open[f])
		next = append(next, n.open[fb+1:]...)
		n.open = next
	}
}

// cdataAllowed: a CDATA section is one only where the next token is
// foreign content (not at an integration point; Chromium).
func (n *nsTracker) cdataAllowed() bool {
	e, ok := n.top()
	return ok && e.ns != NsHTML && e.ip == noIP
}

// IsHandlerAttr is spec/Attrs.agda isHandler: "on" and one or more ASCII
// lowercase letters — an event handler content attribute (onclick,
// onload), whose value the browser compiles as a function body.
func IsHandlerAttr(name string) bool {
	if len(name) < 3 || name[0] != 'o' || name[1] != 'n' {
		return false
	}
	for i := 2; i < len(name); i++ {
		if name[i] < 'a' || name[i] > 'z' {
			return false
		}
	}
	return true
}
