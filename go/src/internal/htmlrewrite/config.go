// Package htmlrewrite is the HTML stream rewriter — the body-rewriting leg
// of the proxy pipeline. Token-based via golang.org/x/net/html so we don't
// need to materialize the full DOM tree.
//
// Phase 3 scope: URL rewriting in attributes, integrity/CSP stripping,
// crossorigin/sandbox normalization, srcset rewriting, the cookie-onload
// hooks the client lib relies on, and the bootstrap-script injection at
// <head>. Style/event-attr/srcdoc inline rewriting is stubbed until the
// JS and CSS rewriters land in phases 4-5.
package htmlrewrite

import (
	"net/url"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// Config holds everything the rewriter needs for one document.
type Config struct {
	// BaseURL is the page's *original* URL — relative URLs in the body
	// resolve against this, not against the proxy URL. Set by the proxy
	// handler from the decoded ?goto= param.
	BaseURL *url.URL

	// Proxy is the rewriter's listening endpoints.
	Proxy urlrewrite.ProxyConfig

	// RewriterJSPath is the URL path the bootstrap <script src="..."> points
	// at (defaults to /rewriter.js).
	RewriterJSPath string

	// HeadInjectionPath is the URL path of the per-page state script that
	// installs the page's effective base URL + initial cookies (defaults
	// to /head-injection).
	HeadInjectionPath string

	// InjectBootstrap controls whether the rewriter injects the <script>
	// chain that wires window.$rewriter into the page. Disabled for embedded
	// fragments (link rel=import, srcdoc subtrees).
	InjectBootstrap bool

	// ClientPassthrough is the JSON-serializable subset of vhost config the
	// server hands to $rewriter_init at boot. The rewriter embeds it verbatim
	// into the inline bootstrap script.
	ClientPassthrough map[string]any

	// RewriteInlineJS, when non-nil, is invoked on the text content of every
	// non-event-handler <script> block in the document. The hook lets us
	// inject the JS rewriter without coupling the htmlrewrite package to
	// jsrewrite directly. Returns the rewritten source.
	RewriteInlineJS func([]byte) []byte

	// RewriteInlineCSS, when non-nil, is invoked on:
	//   - the text content of every <style> block
	//   - the value of every `style="..."` attribute
	// Same decoupling pattern as RewriteInlineJS.
	RewriteInlineCSS func([]byte) []byte
}

// externalResourceAttrs is the (tagName → attribute names) map that drives
// URL rewriting. Order within the inner slice doesn't matter — every attr
// in the slice gets rewritten if present on the tag.
var externalResourceAttrs = map[string][]string{
	"a":      {"href", "ping"},
	"area":   {"href"},
	"audio":  {"src"},
	"body":   {"background"},
	"button": {"formaction"},
	"embed":  {"src"},
	"form":   {"action"},
	"frame":  {"src"},
	"iframe": {"src"},
	"img":    {"src"},
	"input":  {"formaction", "src"},
	"link":   {"href"},
	"object": {"data"},
	"script": {"src"},
	"source": {"src"},
	"table":  {"background"},
	"tbody":  {"background"},
	"td":     {"background"},
	"tfoot":  {"background"},
	"th":     {"background"},
	"thead":  {"background"},
	"tr":     {"background"},
	"track":  {"src"},
	"use":    {"href", "xlink:href"},
	"video":  {"src", "poster"},
}

// tagsWithRestUrls receive REST-formatted (`/load/<b64>/`) proxified URLs
// instead of query-form (`/?goto=<b64>`). Form POSTs and button submits land
// on a path the server can route by prefix. Currently unused — the server
// emits query form universally; REST mode is a TODO.
var tagsWithRestUrls = map[string]bool{
	"form":   true,
	"input":  true,
	"button": true,
}

// htmlEventAttrs is the set of intrinsic event handlers that contain JS
// source code. Phase 4 will pipe these through the JS rewriter; phase 3
// leaves them alone (known passthrough — server-side AST rewriting of
// inline event handlers happens once we have the JS rewriter ported).
var htmlEventAttrs = map[string]bool{
	"onabort": true, "oncancel": true, "oncanplay": true, "oncanplaythrough": true,
	"onchange": true, "onclick": true, "oncuechange": true, "ondblclick": true,
	"ondurationchange": true, "onemptied": true, "onended": true, "oninput": true,
	"oninvalid": true, "onkeydown": true, "onkeypress": true, "onkeyup": true,
	"onloadeddata": true, "onloadedmetadata": true, "onloadstart": true,
	"onmousedown": true, "onmouseenter": true, "onmouseleave": true, "onmousemove": true,
	"onmouseout": true, "onmouseover": true, "onmouseup": true, "onmousewheel": true,
	"onpause": true, "onplay": true, "onplaying": true, "onprogress": true,
	"onratechange": true, "onreset": true, "onseeked": true, "onseeking": true,
	"onselect": true, "onshow": true, "onstalled": true, "onsubmit": true,
	"onsuspend": true, "ontimeupdate": true, "ontoggle": true, "onvolumechange": true,
	"onwaiting": true, "onafterprint": true, "onbeforeprint": true, "onbeforeunload": true,
	"onhashchange": true, "onmessage": true, "onoffline": true, "ononline": true,
	"onpagehide": true, "onpageshow": true, "onpopstate": true, "onstorage": true,
	"onunload": true, "onreadystatechange": true, "onblur": true, "onerror": true,
	"onfocus": true, "onload": true, "onresize": true, "onscroll": true,
	"onanimationend": true, "onanimationiteration": true, "onanimationstart": true,
	"oncontextmenu": true, "oncopy": true, "oncut": true, "ondrag": true,
	"ondragend": true, "ondragenter": true, "ondragleave": true, "ondragover": true,
	"ondragstart": true, "ondrop": true, "onfocusin": true, "onfocusout": true,
	"onfullscreenchange": true, "onfullscreenerror": true, "onopen": true,
	"onpaste": true, "ontouchcancel": true, "ontouchend": true, "ontouchmove": true,
	"ontouchstart": true, "ontransitionend": true, "onwheel": true,
}
