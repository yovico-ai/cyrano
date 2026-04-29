package htmlrewrite

import "strings"

// rewriteSrcset rewrites every URL in an HTML srcset attribute, leaving the
// width/density descriptor (`1x`, `2w`, etc.) attached to its original URL.
//
// Spec: https://html.spec.whatwg.org/multipage/embedded-content.html#image-candidate-string
//
// Commas inside URLs are vanishingly rare and not handled — the spec allows
// them in theory but real-world srcsets don't use them.
func rewriteSrcset(srcset string, rewriteURL func(string) string) string {
	parts := strings.Split(srcset, ",")
	for i, candidate := range parts {
		// Preserve the original whitespace around each candidate so we
		// round-trip cleanly — `, ` separators stay `, `.
		leading := candidate[:len(candidate)-len(strings.TrimLeft(candidate, " \t\n\r\v"))]
		trimmed := strings.TrimSpace(candidate)
		if trimmed == "" {
			continue
		}
		// Split on first whitespace run: URL then descriptor.
		ws := strings.IndexAny(trimmed, " \t\n\r\v")
		if ws < 0 {
			parts[i] = leading + rewriteURL(trimmed)
			continue
		}
		urlPart := trimmed[:ws]
		descriptor := trimmed[ws:]
		parts[i] = leading + rewriteURL(urlPart) + descriptor
	}
	return strings.Join(parts, ",")
}
