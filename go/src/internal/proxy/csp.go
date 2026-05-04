package proxy

import "strings"

// rewriteCSP rewrites a Content-Security-Policy (or CSP-Report-Only) header
// value so the proxy can operate transparently. Two mutations are applied:
//
//  1. Nonce stripping (script/style/default-src directives only):
//     'nonce-…' tokens are removed and 'strict-dynamic' is dropped alongside
//     them. 'self' and 'unsafe-inline' are added so our injected rewriter.js
//     and bootstrap <script> block can load and execute. Nonces serve no
//     isolation purpose in a proxy context — all frames are already same-origin
//     with the proxy, so nonces only block us.
//
//  2. Proxy origin injection (all *-src source-list directives):
//     When proxyOrigin is non-empty (e.g. "https://proxy.example.com"), it is
//     appended to every directive whose name ends in "-src". This is necessary
//     because our client-side rewriter rewrites resource URLs to go through
//     the proxy: a page with "script-src https://cdn.ampproject.org/" would
//     otherwise block scripts rewritten to
//     "https://proxy.example.com/cyrano/https/cdn.ampproject.org/…".
//
// Directives whose names do NOT end in "-src" (sandbox, report-uri, report-to,
// upgrade-insecure-requests, …) are passed through unchanged.
func rewriteCSP(csp, proxyOrigin string) string {
	directives := strings.Split(csp, ";")
	for i, dir := range directives {
		parts := strings.Fields(dir)
		if len(parts) == 0 {
			continue
		}
		name := strings.ToLower(parts[0])
		if !strings.Contains(name, "-src") {
			continue
		}

		isNonceTarget := isScriptOrStyleDirective(name)

		// Preserve any leading whitespace ("; directive" → " directive") so the
		// rejoined header string stays close to the original format.
		lead := dir[:len(dir)-len(strings.TrimLeft(dir, " \t"))]
		kept := []string{parts[0]} // directive name preserved verbatim
		hadNonce := false
		hasUnsafeInline := false
		hasSelf := false
		hasProxy := proxyOrigin == "" // skip proxy-origin check when not configured

		for _, tok := range parts[1:] {
			lower := strings.ToLower(tok)
			switch {
			case isNonceTarget && strings.HasPrefix(lower, "'nonce-"):
				hadNonce = true
				// stripped
			case isNonceTarget && lower == "'strict-dynamic'":
				hadNonce = true // mark changed; drop strict-dynamic alongside nonces
				// stripped
			case lower == "'unsafe-inline'":
				hasUnsafeInline = true
				kept = append(kept, tok)
			case lower == "'self'":
				hasSelf = true
				kept = append(kept, tok)
			default:
				if !hasProxy && strings.EqualFold(tok, proxyOrigin) {
					hasProxy = true
				}
				kept = append(kept, tok)
			}
		}

		changed := false
		if isNonceTarget && hadNonce {
			if !hasUnsafeInline {
				kept = append(kept, "'unsafe-inline'")
			}
			if !hasSelf {
				kept = append(kept, "'self'")
			}
			changed = true
		}
		if !hasProxy {
			kept = append(kept, proxyOrigin)
			changed = true
		}
		if changed {
			directives[i] = lead + strings.Join(kept, " ")
		}
	}
	return strings.Join(directives, ";")
}

func isScriptOrStyleDirective(name string) bool {
	switch name {
	case "default-src",
		"script-src", "script-src-elem", "script-src-attr",
		"style-src", "style-src-elem", "style-src-attr":
		return true
	}
	return false
}
