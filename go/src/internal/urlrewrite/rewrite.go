// Package urlrewrite implements URL containment — the function that turns
// any external URL into a URL pointing at this proxy with the original
// URL encoded in the `?goto=` query parameter. This is the foundation of
// the clientless VPN: every external link in rewritten HTML/CSS/JS gets
// run through Rewrite() before being emitted.
//
// Wire-compatible with the TS client's url/containment.ts:rewriteUrl.
// Producing byte-identical proxified URLs across runtimes is a hard
// requirement so server-rewritten HTML and client-side dynamic rewrites
// agree on the URL of every resource.
package urlrewrite

import (
	"net/url"
	"strings"

	"github.com/yovico/cyrano/internal/b64u"
)

// ProxyConfig is the subset of vhost config Rewrite cares about.
//
// PublicURL is the single user-facing origin — the `scheme://host[:port]`
// the browser sees in its address bar, before any load balancer or TLS-
// terminating frontend. Every rewritten URL lands here. The Go server
// itself may listen on a different scheme/port (load balancer terminates
// TLS, etc.); that's an operational concern handled outside this package.
type ProxyConfig struct {
	PublicURL *url.URL
}

// resolvableSchemes are the schemes whose URLs we route through the proxy.
// Everything else (mailto:, data:, blob:, javascript:, ...) is passed through
// unchanged because the proxy can't meaningfully fetch them on the user's
// behalf.
var resolvableSchemes = map[string]bool{
	"http:":  true,
	"https:": true,
	"ws:":    true,
	"wss:":   true,
}

// passthroughPrefixes mirrors the JS rewriter's quick-bail list. Lowercased.
var passthroughPrefixes = []string{
	"javascript:",
	"data:",
	"blob:",
	"mailto:",
	"tel:",
	"about:",
}

// APIBase returns the proxy origin (scheme://host[:port]) the page should hit.
// This is just cfg.PublicURL serialized — there's exactly one proxy origin
// regardless of the target's scheme.
func APIBase(cfg ProxyConfig) string {
	if cfg.PublicURL == nil {
		return ""
	}
	return cfg.PublicURL.Scheme + "://" + cfg.PublicURL.Host
}

// IsProxyHost reports whether u points at our public origin (scheme + host
// must both match). Default ports (80/443) are normalized so an explicit
// port matches an implicit one.
func IsProxyHost(u *url.URL, cfg ProxyConfig) bool {
	if u == nil || cfg.PublicURL == nil {
		return false
	}
	if u.Scheme != cfg.PublicURL.Scheme {
		return false
	}
	return effectiveHost(u) == effectiveHost(cfg.PublicURL)
}

// effectiveHost returns host:port with default ports made explicit, so
// `https://example.com` and `https://example.com:443` compare equal.
func effectiveHost(u *url.URL) string {
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		switch u.Scheme {
		case "https":
			port = "443"
		case "http":
			port = "80"
		}
	}
	if port == "" {
		return host
	}
	return host + ":" + port
}

// IsAlreadyProxified is true when u is on the proxy host AND already carries
// a goto= query param — i.e. some upstream step already rewrote it. Avoids
// the catastrophic "double-rewrite" case (?goto=<b64-of-?goto=<b64-of-...>>).
func IsAlreadyProxified(u *url.URL, cfg ProxyConfig) bool {
	if !IsProxyHost(u, cfg) {
		return false
	}
	return u.Query().Has("goto")
}

// Rewrite returns the proxified form of rawURL.
//
// rawURL may be absolute, protocol-relative ("//host/..."), or relative; it's
// resolved against baseURL the way a browser would. baseURL is the page's
// original URL (the one the user is browsing on), not the proxy URL.
//
// Returns rawURL unchanged when:
//   - rawURL starts with '#' (in-page anchor)
//   - rawURL has a non-resolvable scheme (mailto:, data:, ...)
//   - rawURL fails to parse against baseURL
//   - the resolved URL is already on the proxy with a goto= param
//
// Returns the resolved absolute URL unchanged when it points directly at the
// proxy host without a goto= param (already a same-origin request — leave
// it alone).
func Rewrite(rawURL string, baseURL *url.URL, cfg ProxyConfig) string {
	if rawURL == "" || strings.HasPrefix(rawURL, "#") {
		return rawURL
	}
	lower := strings.ToLower(rawURL)
	for _, p := range passthroughPrefixes {
		if strings.HasPrefix(lower, p) {
			return rawURL
		}
	}

	normalized := rawURL
	if strings.HasPrefix(normalized, "//") {
		normalized = baseURL.Scheme + ":" + normalized
	}

	abs, err := baseURL.Parse(normalized)
	if err != nil || abs == nil {
		return rawURL
	}

	if !resolvableSchemes[abs.Scheme+":"] {
		return rawURL
	}
	if IsAlreadyProxified(abs, cfg) {
		return rawURL
	}
	if IsProxyHost(abs, cfg) {
		return abs.String()
	}

	// Strip fragment from the encoded "load" payload (matches the JS rewriter).
	target := *abs
	target.Fragment = ""
	encoded := b64u.Encode(target.String())

	out := APIBase(cfg) + "/?goto=" + encoded
	if abs.Fragment != "" {
		out += "#" + abs.Fragment
	}
	return out
}

// Unwrap is Rewrite's inverse: given a proxified URL, recover the original.
// Returns proxiedHref unchanged if it's not a proxified URL.
func Unwrap(proxiedHref string, cfg ProxyConfig) string {
	u, err := url.Parse(proxiedHref)
	if err != nil || !IsProxyHost(u, cfg) {
		return proxiedHref
	}
	load := u.Query().Get("goto")
	if load == "" {
		return proxiedHref
	}
	original, err := b64u.Decode(load)
	if err != nil {
		return proxiedHref
	}
	if u.Fragment != "" {
		return original + "#" + u.Fragment
	}
	return original
}
