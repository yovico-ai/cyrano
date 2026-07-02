package proxy

import "strings"

// rewriteCSP rewrites a Content-Security-Policy (or CSP-Report-Only) header
// value so the proxy can operate transparently. Four mutations are applied:
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
//     appended to every directive whose name ends in "-src" and does not
//     already have 'none'. This is necessary because our client-side rewriter
//     rewrites resource URLs to go through the proxy: a page with
//     "script-src https://cdn.ampproject.org/" would otherwise block scripts
//     rewritten to "https://proxy.example.com/cyrano/https/cdn.ampproject.org/…".
//     Directives with 'none' are left alone — 'none' combined with any other
//     source is a browser warning and the directive type isn't proxied anyway.
//
//  3. report-uri / report-to stripping:
//     These directives cause the browser to POST CSP violation reports directly
//     to the origin server, leaking proxy-context URL patterns. They are
//     removed entirely — the origin's CSP report endpoint is meaningless when
//     all URLs are rewritten through the proxy anyway.
//
//  4. Trusted Types stripping (require-trusted-types-for / trusted-types):
//     Trusted Types enforcement requires DOM-mutating operations (innerHTML,
//     script.src, eval) to go through a registered policy that produces
//     TrustedHTML/TrustedScript/TrustedScriptURL objects. Our injected scripts
//     and prototype patches (e.g. the script.src getter that de-proxifies URLs)
//     return plain strings that fail enforcement. Since we already modify page
//     content (JS/HTML rewriting), the Trusted Types security model cannot be
//     upheld in proxy context anyway — strip both directives to disable it.
//
// All other directives (sandbox, upgrade-insecure-requests, …) pass through
// unchanged.
func rewriteCSP(csp, proxyOrigin string) string {
	raw := strings.Split(csp, ";")
	var out []string
	for _, dir := range raw {
		parts := strings.Fields(dir)
		if len(parts) == 0 {
			out = append(out, dir)
			continue
		}
		name := strings.ToLower(parts[0])

		// Strip report-uri and report-to — they direct the browser to POST
		// violation reports to the origin server, bypassing URL containment.
		if name == "report-uri" || name == "report-to" {
			continue
		}
		// Strip Trusted Types directives — enforcement breaks our injected
		// scripts and prototype patches that return plain strings.
		if name == "require-trusted-types-for" || name == "trusted-types" {
			continue
		}

		if !strings.Contains(name, "-src") {
			out = append(out, dir)
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
		hasNone := false
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
			case lower == "'none'":
				hasNone = true
				kept = append(kept, tok)
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
		// Don't inject proxy origin when 'none' is present — 'none' combined
		// with any other source is a browser warning and the 'none' is ignored.
		// Directives locked to 'none' (e.g. object-src 'none') block that
		// resource type entirely and we don't need to route it through the proxy.
		if !hasProxy && !hasNone {
			kept = append(kept, proxyOrigin)
			changed = true
		}

		if changed {
			out = append(out, lead+strings.Join(kept, " "))
		} else {
			out = append(out, dir)
		}
	}
	return strings.Join(out, ";")
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
