package urlrewrite

// What a direct browser sends upstream as Referer, Origin and
// Sec-Fetch-Site (spec/Referrer.agda): under cyrano every page and
// resource is on the proxy origin, so the browser's own values are computed
// against proxy URLs and say nothing of what it would send directly. These
// functions recompute them from the original URLs.

import (
	"strings"

	"golang.org/x/net/publicsuffix"
)

// Policy is a referrer policy (W3C Referrer Policy §3).
type Policy string

const (
	NoReferrer                  Policy = "no-referrer"
	NoReferrerWhenDowngrade     Policy = "no-referrer-when-downgrade"
	SameOrigin                  Policy = "same-origin"
	Origin                      Policy = "origin"
	StrictOrigin                Policy = "strict-origin"
	OriginWhenCrossOrigin       Policy = "origin-when-cross-origin"
	StrictOriginWhenCrossOrigin Policy = "strict-origin-when-cross-origin"
	UnsafeURL                   Policy = "unsafe-url"

	// DefaultPolicy applies when a document sets none.
	DefaultPolicy = StrictOriginWhenCrossOrigin
)

var policies = map[string]Policy{
	"no-referrer": NoReferrer, "no-referrer-when-downgrade": NoReferrerWhenDowngrade,
	"same-origin": SameOrigin, "origin": Origin, "strict-origin": StrictOrigin,
	"origin-when-cross-origin":        OriginWhenCrossOrigin,
	"strict-origin-when-cross-origin": StrictOriginWhenCrossOrigin, "unsafe-url": UnsafeURL,
}

// PolicyToken reads one policy token (ASCII case-insensitive, trimmed).
func PolicyToken(t string) (Policy, bool) {
	p, ok := policies[lowerASCII(strings.Trim(t, " \t\n\f\r"))]
	return p, ok
}

// HeaderPolicy is the policy a Referrer-Policy header value sets: the last
// recognized token of the comma-separated list ("" when none is).
func HeaderPolicy(v string) Policy {
	var out Policy
	for _, t := range strings.Split(v, ",") {
		if p, ok := PolicyToken(t); ok {
			out = p
		}
	}
	return out
}

func (u absURL) originText() string { return u.scheme + "://" + hostPort(u.auth) }

func sameOriginURL(a, b absURL) bool {
	return a.scheme == b.scheme && hostPort(a.auth) == hostPort(b.auth)
}

// hostOf is the host of a canonical authority: no userinfo, no port.
func hostOf(u absURL) string {
	hp := hostPort(u.auth)
	if strings.HasPrefix(hp, "[") {
		if i := strings.IndexByte(hp, ']'); i >= 0 {
			return hp[:i+1]
		}
		return hp
	}
	h, _, _ := strings.Cut(hp, ":")
	return h
}

// trustworthy: Secure Contexts §3.1 for the schemes cyrano proxies — https
// and wss, and loopback hosts.
func trustworthy(u absURL) bool {
	if u.scheme == "https" || u.scheme == "wss" {
		return true
	}
	h := hostOf(u)
	if h == "localhost" || strings.HasSuffix(h, ".localhost") || h == "[::1]" {
		return true
	}
	parts := strings.Split(h, ".")
	return len(parts) == 4 && parts[0] == "127"
}

func downgrade(from, to absURL) bool { return trustworthy(from) && !trustworthy(to) }

func (u absURL) asReferrer() string {
	return u.originText() + pathText(u.path) + queryText(u.query)
}

// Referrer is the Referer a direct browser sends for a request to target
// from a document at ref under policy (§8.3); ok is false for none. Inputs
// are original URLs; ok is also false when either does not parse.
func Referrer(p Policy, ref, target string) (string, bool) {
	r, rres := parseRef(nil, preprocess(ref))
	t, tres := parseRef(nil, preprocess(target))
	if rres != parsedURL || tres != parsedURL {
		return "", false
	}
	only := r.originText() + "/"
	full := r.asReferrer()
	if len([]rune(full)) > 4096 { // Chromium
		full = only
	}
	same, down := sameOriginURL(r, t), downgrade(r, t)
	switch p {
	case NoReferrer:
		return "", false
	case NoReferrerWhenDowngrade:
		return full, !down
	case SameOrigin:
		return full, same
	case Origin:
		return only, true
	case StrictOrigin:
		return only, !down
	case OriginWhenCrossOrigin:
		if same {
			return full, true
		}
		return only, true
	case UnsafeURL:
		return full, true
	default: // strict-origin-when-cross-origin
		if same {
			return full, true
		}
		return only, !down
	}
}

// OriginHeader is the Origin header a direct browser sends (Fetch §3.1) for
// a request with this Sec-Fetch-Mode and method from a document at init to
// target; ok is false for none.
func OriginHeader(mode string, safeMethod bool, p Policy, init, target string) (string, bool) {
	i, ires := parseRef(nil, preprocess(init))
	t, tres := parseRef(nil, preprocess(target))
	if ires != parsedURL || tres != parsedURL {
		return "", false
	}
	o := i.originText()
	if mode == "websocket" || (mode == "cors" && !sameOriginURL(i, t)) {
		return o, true
	}
	if safeMethod {
		return "", false
	}
	null := false
	switch p {
	case NoReferrer:
		null = true
	case NoReferrerWhenDowngrade, StrictOrigin, StrictOriginWhenCrossOrigin:
		null = downgrade(i, t)
	case SameOrigin:
		null = !sameOriginURL(i, t)
	}
	if null {
		return "null", true
	}
	return o, true
}

// registrable is a host's registrable domain (eTLD+1), or "" when it has
// none (an IP address, a public suffix itself).
func registrable(host string) string {
	if strings.HasPrefix(host, "[") || endsInNumber(host) {
		return ""
	}
	s, err := publicsuffix.EffectiveTLDPlusOne(host)
	if err != nil {
		return ""
	}
	return s
}

// SchemefulSite is a URL's schemeful site, "scheme://registrable-domain"
// (the host itself where it has no registrable domain), or "" when it does
// not parse.
func SchemefulSite(raw string) string {
	u, res := parseRef(nil, preprocess(raw))
	if res != parsedURL {
		return ""
	}
	site := registrable(hostOf(u))
	if site == "" {
		site = hostOf(u)
	}
	return u.scheme + "://" + site
}

// SecFetchSite is the Sec-Fetch-Site a direct browser sends for a request
// from a document at init to target (schemeful same-site), or "" when
// either does not parse.
func SecFetchSite(init, target string) string {
	i, ires := parseRef(nil, preprocess(init))
	t, tres := parseRef(nil, preprocess(target))
	if ires != parsedURL || tres != parsedURL {
		return ""
	}
	return secFetchSite(i, registrable(hostOf(i)), t, registrable(hostOf(t)))
}

func secFetchSite(i absURL, iSite string, t absURL, tSite string) string {
	if sameOriginURL(i, t) {
		return "same-origin"
	}
	if i.scheme == t.scheme {
		if iSite != "" && tSite != "" && iSite == tSite {
			return "same-site"
		}
		if iSite == "" && tSite == "" && hostOf(i) == hostOf(t) {
			return "same-site"
		}
	}
	return "cross-site"
}
