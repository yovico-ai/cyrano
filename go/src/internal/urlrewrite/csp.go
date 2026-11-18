package urlrewrite

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
)

// TrustedTypesPolicy is the name of the runtime's own Trusted Types policy:
// random per server process, so a page cannot name it. The client is told
// it in its config ("tt").
var TrustedTypesPolicy = func() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "_crn0policy"
	}
	return "_" + hex.EncodeToString(b)
}()

// rewriteCSP rewrites a Content-Security-Policy (or CSP-Report-Only) header
// value so the proxy can operate transparently. Four things are done:
//
//  1. Nonces and hashes (script/style/default-src directives only):
//     A nonce is kept, and 'strict-dynamic' with it: the page's scripts
//     carry their nonce attribute through rewriting, and cyrano's injected
//     bootstrap scripts are given the same nonce (ScriptNonce; the HTML
//     rewriter's Config.ScriptNonce). Keeping it matters: a nonce authorizes
//     a script whatever its URL — Facebook loads scripts from data: URLs
//     that only the nonce allows.
//     A hash is of the page's original inline script; the rewritten script
//     cannot match it. A directive with hashes therefore falls back to
//     dropping its nonces, hashes and 'strict-dynamic' and adding
//     'unsafe-inline' and 'self'.
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
//  4. Trusted Types (require-trusted-types-for / trusted-types) stay:
//     a page that asks for them finds them enforced — a string assigned to
//     innerHTML throws, a policy it did not allow cannot be made. Sites
//     check (Cloudflare's challenge turns interactive, and fails, when its
//     frame's policy is not enforced). The runtime writes into the same
//     sinks, so it has a policy of its own (TrustedTypesPolicy; TS:
//     native/trusted.ts), which a `trusted-types` directive is made to
//     admit beside the page's — replacing 'none', which admits no policy.
//
// All other directives (sandbox, upgrade-insecure-requests, …) pass through
// unchanged.
// RewriteCSP translates a Content-Security-Policy (a header's, or a
// <meta http-equiv>'s content) for the proxy. TS: html-rewriter.ts
// rewriteCspContent.
func RewriteCSP(csp, proxyOrigin string) string {
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
		// Trusted Types stay enforced (see 4. above). The runtime's own
		// policy is admitted beside the page's.
		if name == "trusted-types" {
			var kept []string
			has := false
			for _, tok := range parts[1:] {
				if strings.EqualFold(tok, "'none'") {
					continue // "no policy at all": now only the runtime's
				}
				if tok == TrustedTypesPolicy || tok == "*" {
					has = true
				}
				kept = append(kept, tok)
			}
			if !has {
				kept = append(kept, TrustedTypesPolicy)
			}
			lead := dir[:len(dir)-len(strings.TrimLeft(dir, " \t"))]
			out = append(out, lead+parts[0]+" "+strings.Join(kept, " "))
			continue
		}
		// The page's resources are all fetched from the proxy. Served over
		// plain http, "upgrade-insecure-requests" would turn every one of
		// them into an https request the proxy does not answer, and
		// "block-all-mixed-content" would block them. (Over https the
		// directives are harmless and stay.)
		if (name == "upgrade-insecure-requests" || name == "block-all-mixed-content") &&
			strings.HasPrefix(strings.ToLower(proxyOrigin), "http://") {
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

		// Hash-pinned: the fallback (see 1. above). Otherwise nonces stay.
		hashPinned := false
		for _, tok := range parts[1:] {
			if isHashSource(strings.ToLower(tok)) {
				hashPinned = isNonceTarget
			}
		}
		for _, tok := range parts[1:] {
			lower := strings.ToLower(tok)
			switch {
			case isNonceTarget && !hashPinned && (strings.HasPrefix(lower, "'nonce-") || lower == "'strict-dynamic'"):
				kept = append(kept, tok)
			case isNonceTarget && strings.HasPrefix(lower, "'nonce-"):
				hadNonce = true
				// stripped
			case isNonceTarget && (strings.HasPrefix(lower, "'sha256-") ||
				strings.HasPrefix(lower, "'sha384-") ||
				strings.HasPrefix(lower, "'sha512-")):
				// Strip hash-sources too. Like nonces, the mere presence of a
				// hash-source makes the browser IGNORE 'unsafe-inline' — so an
				// origin that hash-pins its own inline scripts would block our
				// injected bootstrap (different content, different hash) and
				// $rewriter would never be defined. Dropping the hashes lets the
				// 'unsafe-inline' we add below cover both the page's inline
				// scripts and ours.
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

func isHashSource(lower string) bool {
	return strings.HasPrefix(lower, "'sha256-") || strings.HasPrefix(lower, "'sha384-") || strings.HasPrefix(lower, "'sha512-")
}

// ScriptNonce is the nonce a script needs under the (rewritten) policies of
// a response, or "" when none asks for one: the first 'nonce-…' of the
// directive that governs script elements (script-src-elem, else script-src,
// else default-src) in the first policy that has one. Report-only policies
// do not block and are not consulted.
func ScriptNonce(policies []string) string {
	for _, policy := range policies {
		byName := map[string][]string{}
		for _, dir := range strings.Split(policy, ";") {
			f := strings.Fields(dir)
			if len(f) > 0 {
				if _, dup := byName[strings.ToLower(f[0])]; !dup {
					byName[strings.ToLower(f[0])] = f[1:]
				}
			}
		}
		for _, name := range []string{"script-src-elem", "script-src", "default-src"} {
			toks, ok := byName[name]
			if !ok {
				continue
			}
			for _, t := range toks {
				if l := strings.ToLower(t); strings.HasPrefix(l, "'nonce-") && strings.HasSuffix(t, "'") {
					return t[len("'nonce-") : len(t)-1]
				}
			}
			break // this directive governs; it has no nonce
		}
	}
	return ""
}
