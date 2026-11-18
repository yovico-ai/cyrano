package urlrewrite

import "strings"

// rewriteSrcset rewrites every URL in an HTML srcset attribute, leaving each
// candidate's descriptor (`1x`, `640w`, …) as written. A port of
// spec/Srcset.agda, which is the authority; keep this in step with it and
// with ts/client/src/patches/srcset.ts.
//
// Spec: https://html.spec.whatwg.org/multipage/images.html#parsing-a-srcset-attribute
//
//   - A URL ends at ASCII whitespace (tab, LF, FF, CR, space). Commas inside
//     it are part of it, as in Cloudflare Image Resizing paths like
//     /cdn-cgi/image/width=640,quality=75,format=auto/https://origin.com/img.jpg
//   - A URL that ends in commas ends its candidate: the commas separate it
//     from the next candidate ("a.jpg, b.jpg 2x").
//   - Otherwise the descriptor runs to the next comma outside parentheses.
//
// RewriteSrcset rewrites each candidate URL of a srcset (img/source srcset,
// a preload link's imagesrcset, the Link header's imagesrcset parameter).
func RewriteSrcset(srcset string, rewriteURL func(string) string) string {
	var out []string
	emit := func(u, desc string) {
		if desc == "" {
			out = append(out, rewriteURL(u))
		} else {
			out = append(out, rewriteURL(u)+" "+desc)
		}
	}
	isWS := func(r rune) bool { return strings.ContainsRune("\t\n\f\r ", r) }

	rs := []rune(srcset)
	i := 0
	for i < len(rs) {
		// Between candidates: whitespace and commas.
		if isWS(rs[i]) || rs[i] == ',' {
			i++
			continue
		}
		// The URL: up to whitespace.
		start := i
		for i < len(rs) && !isWS(rs[i]) {
			i++
		}
		u := string(rs[start:i])
		if strings.HasSuffix(u, ",") {
			emit(strings.TrimRight(u, ","), "")
			continue
		}
		// The descriptor: up to a comma outside parentheses.
		for i < len(rs) && isWS(rs[i]) {
			i++
		}
		start, paren := i, false
		for i < len(rs) && (paren || rs[i] != ',') {
			switch rs[i] {
			case '(':
				paren = true
			case ')':
				paren = false
			}
			i++
		}
		emit(u, strings.TrimRightFunc(string(rs[start:i]), isWS))
	}
	return strings.Join(out, ", ")
}
