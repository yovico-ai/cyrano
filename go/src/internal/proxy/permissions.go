package proxy

import (
	"net/http"
	"regexp"
	"strings"
)

// Permissions-Policy (and its predecessor Feature-Policy) allow or deny
// browser features per origin, and a page's scripts can see the result
// (a denied feature throws or is absent; document.featurePolicy lists
// them). The header is kept, with its allowlists translated to the proxy:
// `()`, `*` and `self` mean the same there; an allowlist that names
// origins names upstream ones, which on the proxy are all `self`.
//
// Known gap: a feature allowed only for some other origin is then allowed
// for every proxied frame, since they share the proxy origin.

var allowlist = regexp.MustCompile(`\(([^)]*)\)`)

func translatePermissionsPolicy(h http.Header) {
	if vs := h.Values("Permissions-Policy"); len(vs) > 0 {
		h.Del("Permissions-Policy")
		for _, v := range vs {
			h.Add("Permissions-Policy", allowlist.ReplaceAllStringFunc(v, func(list string) string {
				return "(" + strings.Join(toSelf(strings.Fields(list[1:len(list)-1]), "self", "src", "*"), " ") + ")"
			}))
		}
	}
	if vs := h.Values("Feature-Policy"); len(vs) > 0 {
		h.Del("Feature-Policy")
		for _, v := range vs {
			directives := strings.Split(v, ";")
			for i, d := range directives {
				f := strings.Fields(d)
				if len(f) > 1 {
					directives[i] = " " + f[0] + " " + strings.Join(toSelf(f[1:], "'self'", "'src'", "*", "'none'"), " ")
				}
			}
			h.Add("Feature-Policy", strings.TrimSpace(strings.Join(directives, ";")))
		}
	}
}

// toSelf keeps the tokens that mean the same on the proxy (keep; the first
// is the self token) and replaces every origin by one self.
func toSelf(tokens []string, keep ...string) []string {
	var out []string
	seenSelf := false
	for _, t := range tokens {
		kept := false
		for _, k := range keep {
			if t == k {
				kept = true
			}
		}
		if !kept {
			t = keep[0]
		}
		if t == keep[0] {
			if seenSelf {
				continue
			}
			seenSelf = true
		}
		out = append(out, t)
	}
	return out
}
