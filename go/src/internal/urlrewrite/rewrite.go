// Package urlrewrite implements URL containment — the function that turns
// any external URL into a URL pointing at this proxy with the original
// URL encoded in the path as /cyrano/<scheme>/<host><path>[?query].
// This is the foundation of the clientless VPN: every external link in
// rewritten HTML/CSS/JS gets run through Rewrite() before being emitted.
//
// Wire-compatible with the TS client's url/containment.ts:rewriteUrl.
// Producing byte-identical proxified URLs across runtimes is a hard
// requirement so server-rewritten HTML and client-side dynamic rewrites
// agree on the URL of every resource.
package urlrewrite

import (
	"net/url"
	"strings"
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

// IsAlreadyProxified is true when u is on the proxy host AND the path starts
// with /cyrano/ — i.e. some upstream step already rewrote it. Avoids the
// catastrophic "double-rewrite" case.
func IsAlreadyProxified(u *url.URL, cfg ProxyConfig) bool {
	if !IsProxyHost(u, cfg) {
		return false
	}
	return strings.HasPrefix(u.Path, "/cyrano/")
}

// ParseCyranoPath parses a /cyrano/<scheme>/<host><path> URL path and raw
// query string back into the original target URL. Returns (target, true) on
// success, (nil, false) when the path is not a valid cyrano path.
func ParseCyranoPath(urlPath, rawQuery string) (*url.URL, bool) {
	const prefix = "/cyrano/"
	if !strings.HasPrefix(urlPath, prefix) {
		return nil, false
	}
	rest := urlPath[len(prefix):]

	// First segment: scheme (everything before first '/').
	idx := strings.Index(rest, "/")
	if idx < 0 {
		return nil, false
	}
	scheme := rest[:idx]
	rest = rest[idx+1:]

	// Second segment: host (everything before next '/').
	idx = strings.Index(rest, "/")
	var host, path string
	if idx < 0 {
		host = rest
		path = "/"
	} else {
		host = rest[:idx]
		path = rest[idx:]
	}
	if host == "" || scheme == "" {
		return nil, false
	}
	return &url.URL{
		Scheme:   scheme,
		Host:     host,
		Path:     path,
		RawQuery: rawQuery,
	}, true
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
//   - the resolved URL is already on the proxy with a /cyrano/ path
//
// Returns the resolved absolute URL unchanged when it points directly at the
// proxy host without a /cyrano/ path (already a same-origin request — leave
// it alone).
func Rewrite(rawURL string, baseURL *url.URL, cfg ProxyConfig) string {
	if rawURL == "" || strings.HasPrefix(rawURL, "#") {
		return rawURL
	}
	// Strip ASCII whitespace that browsers silently remove from attribute
	// values (tab, LF, CR). Go's url.Parse rejects these as invalid; leaving
	// them in would cause every URL with a stray newline to pass through
	// unproxified.
	rawURL = strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, rawURL)
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

	// Detect "virtual-origin + proxy-path" double-encoding: a script combined
	// the virtual window.location.origin (e.g. "https://www.google.com") with a
	// real proxy path that already contains "/cyrano/<scheme>/", producing a URL
	// like "https://www.google.com/cyrano/https/www.google.com/...".
	// Re-map to our proxy origin instead of proxifying a second time.
	if _, ok := ParseCyranoPath(abs.Path, abs.RawQuery); ok {
		out := APIBase(cfg) + abs.Path
		if abs.RawQuery != "" {
			out += "?" + abs.RawQuery
		}
		if abs.Fragment != "" {
			out += "#" + abs.Fragment
		}
		return out
	}

	// Strip fragment from the "load" payload (matches the JS rewriter).
	target := *abs
	target.Fragment = ""

	escapedPath := target.EscapedPath()
	if escapedPath == "" {
		escapedPath = "/"
	}
	out := APIBase(cfg) + "/cyrano/" + target.Scheme + "/" + target.Host + escapedPath
	if target.RawQuery != "" {
		out += "?" + target.RawQuery
	}
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
	target, ok := ParseCyranoPath(u.Path, u.RawQuery)
	if !ok {
		return proxiedHref
	}
	result := target.String()
	if u.Fragment != "" {
		result += "#" + u.Fragment
	}
	return result
}
