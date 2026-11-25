package proxy

import (
	"context"
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

type ppKey struct{}

// OriginalPermissionsPolicy is the response's Permissions-Policy as the
// origin sent it (the body rewriter runs after the translation, before
// Crn-H is written).
func OriginalPermissionsPolicy(resp *http.Response) []string {
	if resp != nil && resp.Request != nil {
		if v, ok := resp.Request.Context().Value(ppKey{}).([]string); ok {
			return v
		}
	}
	if resp == nil {
		return nil
	}
	return resp.Header.Values("Permissions-Policy")
}

func keepPermissionsPolicy(resp *http.Response) {
	if resp.Request == nil {
		return
	}
	vs := append([]string(nil), resp.Header.Values("Permissions-Policy")...)
	resp.Request = resp.Request.WithContext(context.WithValue(resp.Request.Context(), ppKey{}, vs))
}

// neutralizeCoop: a Cross-Origin-Opener-Policy delivered over a document
// that is not a secure context is ignored (spec/Coop.agda coopOf: HTML
// obtains none there); through the proxy the browser would see it over
// https and act on it. It is told unsafe-none (the page reads the origin's
// value through Crn-H).
func neutralizeCoop(resp *http.Response) {
	if resp.Request == nil || resp.Request.URL == nil || len(resp.Header.Values("Cross-Origin-Opener-Policy")) == 0 {
		return
	}
	if !urlrewrite.Trustworthy(resp.Request.URL) {
		resp.Header.Set("Cross-Origin-Opener-Policy", "unsafe-none")
	}
}

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
