package urlrewrite

// javascript: URLs (spec/JsUrl.agda): the code a URL attribute's
// javascript: URL runs, and the URL written back with that code rewritten.

import (
	"strings"
	"unicode/utf8"
)

// JSURLCode is spec JsUrl.code: the code of a javascript: URL (what the URL
// parser leaves after "javascript:", percent-decoded, read as UTF-8).
func JSURLCode(s string) (string, bool) {
	i, j := 0, len(s)
	for i < j && s[i] <= ' ' {
		i++
	}
	for j > i && s[j-1] <= ' ' {
		j--
	}
	t := s[i:j]
	if strings.ContainsAny(t, "\t\n\r") {
		t = strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(t)
	}
	if len(t) < 11 || !strings.EqualFold(t[:11], "javascript:") {
		return "", false
	}
	return modelUTF8(pctBytes(t[11:])), true
}

// modelUTF8 is spec Query.utf8Decode: a lead byte with its continuation
// bytes is one code point; any other byte is U+FFFD.
func modelUTF8(b []byte) string {
	var out strings.Builder
	cont := func(c byte) bool { return c >= 0x80 && c < 0xC0 }
	for i := 0; i < len(b); {
		c := b[i]
		n := 0
		switch {
		case c < 0x80:
			out.WriteByte(c)
			i++
			continue
		case c >= 0xC0 && c < 0xE0:
			n = 1
		case c >= 0xE0 && c < 0xF0:
			n = 2
		case c >= 0xF0 && c < 0xF5:
			n = 3
		}
		ok := n > 0
		if ok {
			for k := 1; k <= n; k++ {
				if i+k >= len(b) || !cont(b[i+k]) {
					ok = false
					break
				}
			}
		}
		if !ok {
			out.WriteRune(utf8.RuneError)
			i++
			continue
		}
		r := rune(c) & (0x7F >> (n + 1))
		for k := 1; k <= n; k++ {
			r = r<<6 | rune(b[i+k]&0x3F)
		}
		out.WriteRune(r)
		i += n + 1
	}
	return out.String()
}

// EncodeJSURLCode is spec JsUrl.encode: '%', C0 controls, space and DEL
// percent-encoded, nothing else.
func EncodeJSURLCode(code string) string {
	var b strings.Builder
	for i := 0; i < len(code); i++ {
		c := code[i]
		if c == '%' || c < 33 || c == 127 {
			b.WriteByte('%')
			b.WriteByte("0123456789ABCDEF"[c>>4])
			b.WriteByte("0123456789ABCDEF"[c&15])
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

// RewriteJSURL is spec JsUrl.rewriteUrl: a javascript: URL whose code rw
// changes, written back; any other URL as it is.
func RewriteJSURL(s string, rw func(string) string) string {
	code, ok := JSURLCode(s)
	if !ok || rw == nil {
		return s
	}
	now := rw(code)
	if now == code {
		return s
	}
	return "javascript:" + EncodeJSURLCode(now)
}
