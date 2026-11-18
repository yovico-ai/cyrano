package urlrewrite

// Cookies as a direct browser keeps them (spec/Cookies.agda: RFC 6265bis
// with Chromium's choices): reading a Set-Cookie string, deciding whether
// and under what scope it is stored, choosing the cookies for a URL, and
// the wire form in which a script-visible cookie lives in the browser's own
// jar on the proxy origin.

import (
	"sort"
	"strings"

	"golang.org/x/net/publicsuffix"
)

// SameSite values, as the wire flag characters.
const (
	SameSiteNone    = 'n'
	SameSiteLax     = 'l'
	SameSiteStrict  = 't'
	SameSiteDefault = 'u'
)

// SetCookie is a Set-Cookie string, read (§5.6).
type SetCookie struct {
	Name, Value string
	Domain      *string // lowercased, one leading dot removed
	Path        *string // only when it starts with "/"
	Secure      bool
	HTTPOnly    bool
	SameSite    byte
	MaxAge      *string // "-"? DIGIT+, as written
	Expires     *string // as written
}

func trimWSP(s string) string { return strings.Trim(s, " \t") }

func validMaxAge(v string) bool {
	if v == "" {
		return false
	}
	rest := v[1:]
	if !(isDigit(rune(v[0])) || (v[0] == '-' && rest != "")) {
		return false
	}
	return allRunes(rest, isDigit)
}

// ParseSetCookie reads a Set-Cookie string; ok is false when it is ignored.
func ParseSetCookie(s string) (SetCookie, bool) {
	for _, r := range s {
		if (r < 0x20 && r != '\t') || r == 0x7f {
			return SetCookie{}, false
		}
	}
	parts := strings.Split(s, ";")
	c := SetCookie{SameSite: SameSiteDefault}
	if n, v, has := strings.Cut(parts[0], "="); has {
		c.Name, c.Value = trimWSP(n), trimWSP(v)
	} else {
		c.Value = trimWSP(n)
	}
	if len(c.Name)+len(c.Value) > 4096 {
		return SetCookie{}, false
	}
	for _, av := range parts[1:] {
		n, v, _ := strings.Cut(av, "=")
		n, v = lowerASCII(trimWSP(n)), trimWSP(v)
		if len(v) > 1024 {
			continue
		}
		switch n {
		case "expires":
			e := v
			c.Expires = &e
		case "max-age":
			// Chromium: the last Max-Age wins even when it is not a number.
			c.MaxAge = nil
			if validMaxAge(v) {
				m := v
				c.MaxAge = &m
			}
		case "domain":
			d := lowerASCII(strings.TrimPrefix(v, "."))
			c.Domain = &d
		case "path":
			c.Path = nil
			if strings.HasPrefix(v, "/") {
				p := v
				c.Path = &p
			}
		case "secure":
			c.Secure = true
		case "httponly":
			c.HTTPOnly = true
		case "samesite":
			switch lowerASCII(v) {
			case "none":
				c.SameSite = SameSiteNone
			case "strict":
				c.SameSite = SameSiteStrict
			case "lax":
				c.SameSite = SameSiteLax
			default:
				c.SameSite = SameSiteDefault
			}
		}
	}
	return c, true
}

// StoredCookie is a cookie as stored (§5.7).
type StoredCookie struct {
	HostOnly     bool
	Domain, Path string
	Name, Value  string
	Secure       bool
	HTTPOnly     bool
	SameSite     byte
}

func isIPHost(h string) bool { return strings.HasPrefix(h, "[") || endsInNumber(h) }

func domainMatch(host, d string) bool {
	return host == d || (d != "" && strings.HasSuffix(host, "."+d) && !isIPHost(host))
}

func pathMatch(req, cp string) bool {
	if req == cp {
		return true
	}
	return strings.HasPrefix(req, cp) && (strings.HasSuffix(cp, "/") || (len(req) > len(cp) && req[len(cp)] == '/'))
}

func defaultPath(u absURL) string {
	p := pathText(u.path)
	i := strings.LastIndexByte(p, '/')
	if i <= 0 {
		return "/"
	}
	return p[:i]
}

// isPublicSuffix: d is itself a public suffix (public-suffix data is
// outside the spec).
func isPublicSuffix(d string) bool {
	if d == "" || isIPHost(d) {
		return false
	}
	s, _ := publicsuffix.PublicSuffix(d)
	return s == d
}

// StoreCookie decides whether c, set at pageURL (an original URL) by a
// script (api) or an HTTP response, is stored, and under what scope.
func StoreCookie(api bool, pageURL string, c SetCookie) (StoredCookie, bool) {
	u, res := parseRef(nil, preprocess(pageURL))
	if res != parsedURL {
		return StoredCookie{}, false
	}
	ps := c.Domain != nil && isPublicSuffix(*c.Domain)
	return storeCookie(api, ps, u, c)
}

func storeCookie(api, publicSuffix bool, u absURL, c SetCookie) (StoredCookie, bool) {
	prefixed := func(p, s string) bool { return strings.HasPrefix(lowerASCII(s), p) }
	host := hostOf(u)
	hostOnly, domain := true, host
	domainOK := true
	if c.Domain != nil && *c.Domain != "" && !(publicSuffix && *c.Domain == host) {
		hostOnly, domain = false, *c.Domain
		domainOK = !publicSuffix && domainMatch(host, domain)
	}
	path := defaultPath(u)
	if c.Path != nil {
		path = *c.Path
	}
	switch {
	case c.Name == "" && c.Value == "",
		c.Name == "" && (prefixed("__secure-", c.Value) || prefixed("__host-", c.Value)),
		c.HTTPOnly && api,
		c.Secure && !trustworthy(u),
		c.SameSite == SameSiteNone && !c.Secure,
		prefixed("__secure-", c.Name) && !c.Secure,
		prefixed("__host-", c.Name) && !(c.Secure && hostOnly && path == "/"),
		!domainOK:
		return StoredCookie{}, false
	}
	return StoredCookie{hostOnly, domain, path, c.Name, c.Value, c.Secure, c.HTTPOnly, c.SameSite}, true
}

func (c StoredCookie) matches(api bool, u absURL) bool {
	host := hostOf(u)
	if c.HostOnly {
		if host != c.Domain {
			return false
		}
	} else if !domainMatch(host, c.Domain) {
		return false
	}
	return pathMatch(pathText(u.path), c.Path) && (!c.Secure || trustworthy(u)) && !(c.HTTPOnly && api)
}

// ── the wire form ───────────────────────────────────────────────────────

const wirePrefix = "__crn!"

func fieldSet(r rune) bool { return !(isAlpha(r) || isDigit(r) || r == '.' || r == '-') }

// WireName is the cookie's name in the browser's jar: it carries the scope
// and equals the cookie's identity (name, domain, path, host-only).
func (c StoredCookie) WireName() string {
	hd := "d"
	if c.HostOnly {
		hd = "h"
	}
	return wirePrefix + hd + "!" + encodeWith(fieldSet, []rune(c.Domain)) + "!" + encodeWith(fieldSet, []rune(c.Path)) + "!" + c.Name
}

// WireValue carries the Secure and SameSite flags before the value.
func (c StoredCookie) WireValue() string {
	s := "i"
	if c.Secure {
		s = "s"
	}
	return s + string(rune(c.SameSite)) + ":" + c.Value
}

// Unwire reads a jar entry back; ok is false when cyrano did not write it.
func Unwire(name, value string) (StoredCookie, bool) {
	rest, ok := strings.CutPrefix(name, wirePrefix)
	if !ok {
		return StoredCookie{}, false
	}
	f := strings.SplitN(rest, "!", 4)
	if len(f) != 4 || (f[0] != "h" && f[0] != "d") {
		return StoredCookie{}, false
	}
	if len(value) < 3 || value[2] != ':' || (value[0] != 's' && value[0] != 'i') || !strings.ContainsRune("nltu", rune(value[1])) {
		return StoredCookie{}, false
	}
	return StoredCookie{
		HostOnly: f[0] == "h", Domain: pctDecode(f[1]), Path: pctDecode(f[2]), Name: f[3],
		Value: value[3:], Secure: value[0] == 's', SameSite: value[1],
	}, true
}

// JarCookies reads the browser's jar ("n1=v1; n2=v2", as a Cookie header or
// document.cookie lists it): the cookies cyrano wrote, in the jar's order.
func JarCookies(jar string) []StoredCookie {
	var out []StoredCookie
	for _, p := range strings.Split(jar, ";") {
		n, v, _ := strings.Cut(strings.TrimLeft(p, " \t"), "=")
		if c, ok := Unwire(n, v); ok {
			out = append(out, c)
		}
	}
	return out
}

// SelectCookies chooses, from cookies in jar order, those for pageURL:
// longer paths first, the given order kept among equal lengths.
func SelectCookies(api bool, pageURL string, cookies []StoredCookie) []StoredCookie {
	u, res := parseRef(nil, preprocess(pageURL))
	if res != parsedURL {
		return nil
	}
	return selectCookies(api, u, cookies)
}

func selectCookies(api bool, u absURL, cookies []StoredCookie) []StoredCookie {
	var out []StoredCookie
	for _, c := range cookies {
		if c.matches(api, u) {
			out = append(out, c)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return len([]rune(out[i].Path)) > len([]rune(out[j].Path)) })
	return out
}

// CookieString writes cookies as a Cookie header / document.cookie value.
func CookieString(cookies []StoredCookie) string {
	parts := make([]string, len(cookies))
	for i, c := range cookies {
		if c.Name == "" {
			parts[i] = c.Value
		} else {
			parts[i] = c.Name + "=" + c.Value
		}
	}
	return strings.Join(parts, "; ")
}

// SameSiteAllows: may a cookie with this SameSite go on an HTTP request
// (§5.2)? sameSiteReq: the request's initiator is same-site with its
// target, or there is none; topSafeNav: a top-level navigation with a safe
// method.
func SameSiteAllows(sameSite byte, sameSiteReq, topSafeNav bool) bool {
	switch sameSite {
	case SameSiteNone:
		return true
	case SameSiteStrict:
		return sameSiteReq
	default: // Lax, and the default
		return sameSiteReq || topSafeNav
	}
}
