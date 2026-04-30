package htmlrewrite

import "strings"

// rewriteSrcset rewrites every URL in an HTML srcset attribute, leaving the
// width/density descriptor (`1x`, `640w`, etc.) attached to its original URL.
//
// Spec: https://html.spec.whatwg.org/multipage/images.html#parsing-a-srcset-attribute
//
// Per spec, URLs end at ASCII whitespace — commas are valid URL characters and
// appear in Cloudflare Image Resizing paths like:
//
//	/cdn-cgi/image/width=640,quality=75,format=auto/https://origin.com/img.jpg
//
// Candidate separators are commas that appear AFTER a descriptor (or after the
// URL token when no descriptor is present). We detect them by reading the URL
// token up to the first whitespace, then reading the descriptor up to the next
// comma.
func rewriteSrcset(srcset string, rewriteURL func(string) string) string {
	var out []string
	s := srcset

	for {
		// Per spec step 4: skip leading whitespace and commas (separators from
		// the previous candidate, or leading junk).
		s = strings.TrimLeft(s, " \t\n\r\v,")
		if s == "" {
			break
		}

		// Per spec step 6: URL = chars until first ASCII whitespace.
		wsIdx := strings.IndexAny(s, " \t\n\r\v")
		var urlToken string
		if wsIdx < 0 {
			urlToken = s
			s = ""
		} else {
			urlToken = s[:wsIdx]
			s = s[wsIdx:]
		}

		// Per spec step 8: trailing commas on the URL itself are separators.
		urlToken = strings.TrimRight(urlToken, ",")
		if urlToken == "" {
			continue
		}

		// Skip whitespace between URL and optional descriptor.
		s = strings.TrimLeft(s, " \t\n\r\v")

		// Descriptor: chars until the next comma (the next candidate separator).
		commaIdx := strings.Index(s, ",")
		var descriptor string
		if commaIdx < 0 {
			descriptor = strings.TrimSpace(s)
			s = ""
		} else {
			descriptor = strings.TrimSpace(s[:commaIdx])
			s = s[commaIdx:] // leave the comma for the next iteration's TrimLeft
		}

		if descriptor != "" {
			out = append(out, rewriteURL(urlToken)+" "+descriptor)
		} else {
			out = append(out, rewriteURL(urlToken))
		}
	}

	return strings.Join(out, ", ")
}
