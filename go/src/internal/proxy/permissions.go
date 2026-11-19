package proxy

import (
	"net/http"
	"strings"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// Permissions-Policy (and its predecessor Feature-Policy) allow or deny
// browser features per origin, and a page's scripts can see the result
// (a denied feature throws or is absent; document.featurePolicy lists
// them). Permissions-Policy is translated as spec/Permissions.agda says
// (urlrewrite.TranslatePermissionsPolicy; checked against Chromium).
//
// Known gap: a feature allowed only for some other origin is then allowed
// for every proxied frame and for the document itself, since they share
// the proxy origin (document.featurePolicy.allowsFeature tells).
//
// Feature-Policy is translated by the older word rule below (not
// specified: Chromium reads it only for features Permissions-Policy does
// not name).

func translatePermissionsPolicy(h http.Header) {
	if vs := h.Values("Permissions-Policy"); len(vs) > 0 {
		h.Del("Permissions-Policy")
		for _, v := range urlrewrite.TranslatePermissionsPolicy(vs) {
			h.Add("Permissions-Policy", v)
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
