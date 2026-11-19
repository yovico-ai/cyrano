package proxy

import (
	"net/http"

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
// Feature-Policy, which Chromium still reads for the features
// Permissions-Policy does not name, has its origin words written 'self'
// (spec/Allow.agda rewriteFeaturePolicy; checked against Chromium).

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
			h.Add("Feature-Policy", urlrewrite.RewriteFeaturePolicy(v))
		}
	}
}
