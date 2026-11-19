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

// APIBase returns the proxy origin (scheme://host[:port]) the page should hit.
// This is just cfg.PublicURL serialized — there's exactly one proxy origin
// regardless of the target's scheme.
func APIBase(cfg ProxyConfig) string {
	if cfg.PublicURL == nil {
		return ""
	}
	return cfg.PublicURL.Scheme + "://" + cfg.PublicURL.Host
}

// OnProxy reports whether href, read as the browser reads it, is on the
// proxy's public origin: same scheme, host and port (spec sameOrigin —
// userinfo is not part of an origin, a default port is no port).
func OnProxy(href string, cfg ProxyConfig) bool {
	a, res := parseRef(nil, preprocess(href))
	proxy, pres := parseRef(nil, APIBase(cfg))
	return res == parsedURL && pres == parsedURL &&
		a.scheme == proxy.scheme && hostPort(a.auth) == hostPort(proxy.auth)
}

// IsProxyHost is OnProxy for a parsed URL.
func IsProxyHost(u *url.URL, cfg ProxyConfig) bool {
	return u != nil && cfg.PublicURL != nil && OnProxy(u.String(), cfg)
}

// IsAlreadyProxified is true when u is on the proxy under /cyrano/ — what
// proxify produced (spec underCyrano). Avoids wrapping twice.
func IsAlreadyProxified(u *url.URL, cfg ProxyConfig) bool {
	if !IsProxyHost(u, cfg) {
		return false
	}
	a, res := parseRef(nil, preprocess(u.String()))
	return res == parsedURL && len(a.path) >= 2 && a.path[0] == "cyrano"
}

// ParseCyranoURL reads a request URL on the proxy — /cyrano/<scheme>/<host><path>
// — back into the target it names. Returns (target, true) on success,
// (nil, false) when it is not a cyrano path.
//
// The upstream gets the request the browser would have sent directly:
//   - the path is the target's own text, so /a%2Fb stays /a%2Fb upstream
//     (RawPath holds it exactly — see UpstreamPath — and Path its
//     decoded form where there is one);
//   - a bare "?" survives (ForceQuery);
//   - the host segment is read as the browser reads an authority, the same
//     reader Unwrap uses (H.com:443 is h.com, ".:" is "."). Userinfo goes to
//     target.User, never into Host: it is part of the page's URL (relative
//     URLs on the page inherit it) but the Director does not forward it.
func ParseCyranoURL(u *url.URL) (*url.URL, bool) {
	const prefix = "/cyrano/"
	// The decoded path is the target's text exactly: proxify writes every
	// '%' of it as %25 (spec escape), so decoding gives back "%2F" as
	// "%2F" and "/100%.jpg" as itself.
	dec := u.Path
	if !strings.HasPrefix(dec, prefix) {
		return nil, false
	}
	schemeSeg, rest, ok := strings.Cut(dec[len(prefix):], "/")
	if !ok || schemeSeg == "" {
		return nil, false
	}
	scheme, _, okSeg := schemeSegment(schemeSeg)
	if !okSeg {
		return nil, false
	}
	seg, path := rest, "/"
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		seg, path = rest[:i], rest[i:]
	}
	if seg == "" {
		return nil, false
	}
	target := &url.URL{Scheme: scheme, RawQuery: u.RawQuery, ForceQuery: u.ForceQuery}
	target.Path, target.RawPath = path, path
	if p, err := url.PathUnescape(path); err == nil {
		target.Path = p
	}
	if _, proxifiable := defaultPort[scheme]; !proxifiable {
		return nil, false
	}
	auth, after, res := authority(scheme, []rune(seg))
	if res != parsedURL || len(after) != 0 {
		return nil, false
	}
	if at := strings.LastIndexByte(auth, '@'); at >= 0 {
		ui := auth[:at]
		auth = auth[at+1:]
		name, pass, hasPass := strings.Cut(ui, ":")
		name, _ = url.PathUnescape(name)
		pass, _ = url.PathUnescape(pass)
		if hasPass {
			target.User = url.UserPassword(name, pass)
		} else {
			target.User = url.User(name)
		}
	}
	target.Host = auth
	return target, true
}

// ParseCyranoPath is ParseCyranoURL for a decoded path and raw query
// given apart.
func ParseCyranoPath(urlPath, rawQuery string) (*url.URL, bool) {
	return ParseCyranoURL(&url.URL{Path: urlPath, RawQuery: rawQuery})
}

// UpstreamPath is the path to put on the wire for a target from
// ParseCyranoURL — its text exactly — or "" when net/url's own escaping
// must serve (a path starting "//", which as URL.Opaque would be read as
// an authority).
func UpstreamPath(target *url.URL) string {
	p := target.RawPath
	if p == "" || strings.HasPrefix(p, "//") {
		return ""
	}
	return p
}

// escapePct writes every '%' as %25 (spec/Containment.agda escapePct).
func escapePct(s string) string { return strings.ReplaceAll(s, "%", "%25") }

// ProxifiedPath is the /cyrano/… path for a target given as scheme, host
// (with any userinfo, as written in a URL) and escaped path — the one
// place outside Rewrite that may build a proxified path, so the %25 rule
// (spec escapePct) and the ".:" host form (segmentOf) always hold.
func ProxifiedPath(scheme, host, escapedPath string) string {
	if escapedPath == "" {
		escapedPath = "/"
	}
	return "/cyrano/" + scheme + "/" + escapePct(segmentOf(host)) + escapePct(escapedPath)
}

// EscapePct is escapePct, for code that appends a target path to an
// already-built proxified prefix.
func EscapePct(s string) string { return escapePct(s) }

// Rewrite returns the proxified form of rawURL, as spec/Containment.agda
// decides it (rewriteUrl).
//
// rawURL may be absolute, protocol-relative ("//host/..."), or relative; it's
// resolved against baseURL the way a browser would. baseURL is the page's
// original URL (the one the user is browsing on), not the proxy URL.
//
// Returns rawURL exactly as given (owner, 2026-11-17: "exact input") when
// it is empty, an in-page anchor, of a scheme cyrano does not proxify
// (mailto:, data:, ...), rejected by the browser's parser, or already
// proxified. A URL on the proxy origin outside /cyrano/ is returned
// resolved; a /cyrano/<scheme>/<host> path glued to another origin is moved
// onto the proxy origin; anything else is proxified.
func Rewrite(rawURL string, baseURL *url.URL, cfg ProxyConfig) string {
	return RewriteWithPolicy(rawURL, baseURL, cfg, "")
}

// RewriteWithPolicy is Rewrite for a request made under its own referrer
// policy (an element's referrerpolicy, fetch's referrerPolicy): the
// proxified URL carries it in its scheme segment, /cyrano/https!origin/…
// (spec rewriteUrlWith), for the proxy to apply (TargetPolicy). An empty
// policy is Rewrite.
func RewriteWithPolicy(rawURL string, baseURL *url.URL, cfg ProxyConfig, policy Policy) string {
	if rawURL == "" {
		return rawURL
	}
	pre := preprocess(rawURL)
	if strings.HasPrefix(pre, "#") {
		return rawURL
	}
	proxy, pres := parseRef(nil, APIBase(cfg))
	if pres != parsedURL {
		return rawURL // no proxy origin configured
	}
	// The page's URL is always an http(s) URL cyrano fetched; should it
	// not parse, read rawURL without a base (only absolute URLs resolve).
	var basep *absURL
	if baseURL != nil {
		if b, bres := parseRef(nil, baseURL.String()); bres == parsedURL {
			basep = &b
		}
	}
	a, res := parseRef(basep, pre)
	if res != parsedURL {
		return rawURL // another scheme, or rejected by the browser's parser
	}
	if a.scheme == proxy.scheme && hostPort(a.auth) == hostPort(proxy.auth) {
		if len(a.path) >= 2 && a.path[0] == "cyrano" {
			return rawURL
		}
		return a.href()
	}
	if _, _, _, ok := cyranoTarget(a.path); ok {
		return proxy.origin() + pathText(a.path) + queryText(a.query) + fragText(a.frag)
	}
	path := make([]string, len(a.path))
	for i, s := range a.path {
		path[i] = escapePct(s)
	}
	schemeSeg := a.scheme
	if policy != "" {
		schemeSeg += "!" + string(policy)
	}
	return proxy.origin() + "/cyrano/" + schemeSeg + "/" + escapePct(segmentOf(a.auth)) +
		pathText(path) + queryText(a.query) + fragText(a.frag)
}

// segmentOf writes an authority as a path segment (spec segmentOf). A
// host of "." or ".." would be a dot segment the browser removes; an
// empty port (".:"), which the authority parser reads as no port, keeps
// it a plain segment.
func segmentOf(auth string) string {
	if isSingleDot(auth) || isDoubleDot(auth) {
		return auth + ":"
	}
	return auth
}

// cyranoTarget recognizes what proxify itself produces:
// /cyrano/<http|https|ws|wss>/<non-empty host><rest> (owner, 2026-11-17).
func cyranoTarget(path []string) (scheme, host string, rest []string, ok bool) {
	if len(path) < 3 || path[0] != "cyrano" || path[2] == "" {
		return "", "", nil, false
	}
	scheme, _, ok = schemeSegment(path[1])
	if !ok {
		return "", "", nil, false
	}
	return scheme, path[2], path[3:], true
}

// policyNames are the referrer policies a scheme segment may carry, by
// their own names (spec R.policyName).
var markerPolicies = map[Policy]bool{
	NoReferrer: true, NoReferrerWhenDowngrade: true, SameOrigin: true, Origin: true,
	StrictOrigin: true, OriginWhenCrossOrigin: true, StrictOriginWhenCrossOrigin: true, UnsafeURL: true,
}

// schemeSegment reads "<scheme>" or "<scheme>!<policy>" (spec
// schemeSegment): false when the scheme is not one cyrano proxifies or
// the policy is not a policy's name.
func schemeSegment(seg string) (scheme string, policy Policy, ok bool) {
	scheme, pol, marked := strings.Cut(seg, "!")
	if _, proxifiable := defaultPort[scheme]; !proxifiable {
		return "", "", false
	}
	if marked {
		if !markerPolicies[Policy(pol)] {
			return "", "", false
		}
		policy = Policy(pol)
	}
	return scheme, policy, true
}

// ReferrerPolicyToken is the policy an element's referrerpolicy attribute
// or fetch's referrerPolicy names (ASCII case-insensitive), or "".
func ReferrerPolicyToken(v string) Policy {
	p := Policy(asciiLower(v))
	if markerPolicies[p] {
		return p
	}
	return ""
}

// TargetPolicy is the referrer policy a proxified path carries, or ""
// (spec targetPolicy). The path is read as the browser's parser reads it
// (dot segments removed): give it as it came on the wire (EscapedPath).
func TargetPolicy(escapedPath string) Policy {
	a, res := parseRef(nil, preprocess("http://h"+escapedPath))
	if res != parsedURL || len(a.path) < 3 || a.path[0] != "cyrano" || a.path[2] == "" {
		return ""
	}
	_, policy, ok := schemeSegment(a.path[1])
	if !ok {
		return ""
	}
	return policy
}

// Unwrap is Rewrite's inverse (spec/Containment.agda unwrap): given a
// proxified URL, recover the original. Returns proxiedHref unchanged if
// it's not a proxified URL.
func Unwrap(proxiedHref string, cfg ProxyConfig) string {
	a, res := parseRef(nil, preprocess(proxiedHref))
	proxy, pres := parseRef(nil, APIBase(cfg))
	if res != parsedURL || pres != parsedURL || a.scheme != proxy.scheme || hostPort(a.auth) != hostPort(proxy.auth) {
		return proxiedHref
	}
	scheme, seg, rest, ok := cyranoTarget(a.path)
	if !ok {
		return proxiedHref
	}
	// Read the host segment as the browser reads an authority, so what
	// page code sees is what the browser would show (H.com:443 is h.com).
	auth, after, ares := authority(scheme, []rune(pctDecode(seg)))
	if ares != parsedURL || len(after) != 0 {
		return proxiedHref
	}
	orig := make([]string, len(rest))
	for i, s := range rest {
		orig[i] = pctDecode(s)
	}
	if len(orig) == 0 {
		orig = []string{""}
	}
	return scheme + "://" + auth + pathText(orig) + queryText(a.query) + fragText(a.frag)
}
