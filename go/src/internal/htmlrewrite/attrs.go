package htmlrewrite

import "strings"

// AttrKind is what an attribute's value is to cyrano (spec/Attrs.agda;
// TS: ts/client/src/patches/url-attribute-map.ts urlAttrKind).
type AttrKind uint8

const (
	AttrNone      AttrKind = iota
	AttrURL                // fetched or navigated: proxified
	AttrURLList            // space-separated URLs (ping, attributionsrc): each proxified
	AttrSrcset             // a srcset
	AttrReflected          // never fetched; its IDL getter resolves it (cite, longdesc): kept
)

func (k AttrKind) String() string {
	return [...]string{"none", "url", "urllist", "srcset", "reflected"}[k]
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
func URLAttrKind(svg bool, tag, attr string) AttrKind {
	if svg {
		return svgAttrKinds[tag][attr]
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

// nsTracker follows, over the token stream, which elements are SVG (HTML
// tree construction, simplified: <svg> enters, its foreignObject / desc /
// title hold HTML, an HTML breakout tag leaves foreign content).
type nsTracker struct {
	open []nsEntry
}

type nsEntry struct {
	tag string
	svg bool
}

var svgBreakout = map[string]bool{}

func init() {
	for _, t := range strings.Fields("b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var") {
		svgBreakout[t] = true
	}
}

var htmlVoid = map[string]bool{}

func init() {
	for _, t := range strings.Fields("area base br col embed hr img input link meta source track wbr param keygen frame") {
		htmlVoid[t] = true
	}
}

func (n *nsTracker) inSVG() bool {
	if len(n.open) == 0 {
		return false
	}
	top := n.open[len(n.open)-1]
	return top.svg && top.tag != "foreignobject" && top.tag != "desc" && top.tag != "title"
}

// start reports whether the element is SVG and records it as open.
func (n *nsTracker) start(tag string, selfClosing bool, attrs func(string) bool) bool {
	svg := tag == "svg" || n.inSVG()
	if svg && n.inSVG() && (svgBreakout[tag] || tag == "font" && (attrs("color") || attrs("face") || attrs("size"))) {
		for len(n.open) > 0 && n.open[len(n.open)-1].svg {
			n.open = n.open[:len(n.open)-1]
		}
		svg = false
	}
	if !selfClosing && !(!svg && htmlVoid[tag]) {
		n.open = append(n.open, nsEntry{tag, svg})
	}
	return svg
}

func (n *nsTracker) end(tag string) {
	for i := len(n.open) - 1; i >= 0; i-- {
		if n.open[i].tag == tag {
			n.open = n.open[:i]
			return
		}
	}
}
