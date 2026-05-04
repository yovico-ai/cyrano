package proxy

import "strings"

// stripCSPNonces rewrites a Content-Security-Policy (or CSP-Report-Only) header
// value so the proxy's injected scripts and styles can load and execute.
//
// In a proxy context every frame is already same-origin with the proxy, so the
// security isolation that nonces are designed to provide has already collapsed.
// Keeping nonce requirements only blocks our rewriter.js from loading.
//
// For each script-src / style-src / default-src directive that contains a
// nonce token we:
//
//  1. Remove all 'nonce-...' tokens.
//  2. Remove 'strict-dynamic' — it suppresses 'self' and 'unsafe-inline',
//     making the additions below ineffective.
//  3. Add 'self' — allows /rewriter.js (same-origin script) to load.
//  4. Add 'unsafe-inline' — allows the bootstrap <script> block to execute.
func stripCSPNonces(csp string) string {
	if !strings.Contains(csp, "'nonce-") {
		return csp
	}
	directives := strings.Split(csp, ";")
	for i, dir := range directives {
		parts := strings.Fields(dir)
		if len(parts) == 0 {
			continue
		}
		if !isScriptOrStyleDirective(strings.ToLower(parts[0])) {
			continue
		}

		// Preserve any leading whitespace ("; directive" → " directive") so the
		// rejoined header string stays close to the original format.
		lead := dir[:len(dir)-len(strings.TrimLeft(dir, " \t"))]
		kept := []string{parts[0]} // directive name preserved verbatim
		hadNonce := false
		hasUnsafeInline := false
		hasSelf := false

		for _, tok := range parts[1:] {
			lower := strings.ToLower(tok)
			switch {
			case strings.HasPrefix(lower, "'nonce-"):
				hadNonce = true
				// stripped
			case lower == "'strict-dynamic'":
				hadNonce = true // mark changed; drop strict-dynamic alongside nonces
				// stripped
			case lower == "'unsafe-inline'":
				hasUnsafeInline = true
				kept = append(kept, tok)
			case lower == "'self'":
				hasSelf = true
				kept = append(kept, tok)
			default:
				kept = append(kept, tok)
			}
		}

		if hadNonce {
			if !hasUnsafeInline {
				kept = append(kept, "'unsafe-inline'")
			}
			if !hasSelf {
				kept = append(kept, "'self'")
			}
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
