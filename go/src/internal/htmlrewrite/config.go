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

	// InjectBootstrap controls whether the rewriter injects the <script>
	// chain that wires window.$rewriter into the page. Disabled for embedded
	// fragments (link rel=import, srcdoc subtrees).
	InjectBootstrap bool

	// ClientPassthrough is the JSON-serializable subset of vhost config the
	// server hands to $rewriter_init at boot. The rewriter embeds it verbatim
	// into the inline bootstrap script.
	ClientPassthrough map[string]any

	// RewriteInlineJS, when non-nil, is invoked on the text content of every
	// JS <script> block in the document, and on every event handler
	// attribute's value (spec/Attrs.agda handler). The hook lets us
	// inject the JS rewriter without coupling the htmlrewrite package to
	// jsrewrite directly. Returns the rewritten source.
	RewriteInlineJS func([]byte) []byte

	// RewriteDataScript, when non-nil, rewrites the text of a script given
	// a data: URL (<script src="data:…">, classic or module), the URL its
	// base (spec/DataUrl.agda; urlrewrite.RewriteDataScript).
	RewriteDataScript func(dataURL, text string) string

	// RewriteInlineCSS, when non-nil, is invoked on:
	//   - the text content of every <style> block
	//   - the value of every `style="..."` attribute
	// Same decoupling pattern as RewriteInlineJS.
	RewriteInlineCSS func([]byte) []byte

	// ScriptNonce, when set, is put on the injected bootstrap scripts: the
	// page's CSP authorizes scripts by this nonce (proxy.ScriptNonce).
	ScriptNonce string

	// ExternalBootstrap makes the bootstrap's second script an external
	// one (BootPath): the page's CSP lets no inline script run
	// (urlrewrite.InlineScriptAllowed).
	ExternalBootstrap bool

	// OnReferrerPolicy is told the content of a <meta name="referrer"> and
	// reports whether it is a policy (then the tag is given unsafe-url).
	OnReferrerPolicy func(content string) bool

	// baseSeen: a <base href> was met (only the first counts).
	baseSeen bool
	// bootstrapText, when set, stands for the bootstrap (tests).
	bootstrapText string

	// NoOriginals suppresses the originals attribute (OriginalsAttr): for
	// markup no runtime will read.
	NoOriginals bool

	// Prettify, when true, runs JS and CSS content through a formatter before
	// serving. Makes minified challenge scripts readable in DevTools.
	// Never set in production — it changes source text and can interfere with
	// scripts that inspect Function.toString() output.
	Prettify bool
}

// The URL-bearing attributes are in attrs.go (spec/Attrs.agda).

// tagsWithRestUrls receive REST-formatted (`/load/<b64>/`) proxified URLs
// instead of query-form (`/?goto=<b64>`). Form POSTs and button submits land
// on a path the server can route by prefix. Currently unused — the server
// emits query form universally; REST mode is a TODO.
var tagsWithRestUrls = map[string]bool{
	"form":   true,
	"input":  true,
	"button": true,
}

// BootPath serves the bootstrap's second script as an external one, for
// pages whose CSP forbids inline scripts: ?c= the client config (JSON),
// ?u= the document's original URL.
const BootPath = "/cyrano-boot.js"
