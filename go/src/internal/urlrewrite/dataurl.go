package urlrewrite

import (
	"encoding/base64"
	"strings"
	"unicode/utf8"
)

// A data: URL a script is given (spec/DataUrl.agda; TS url/data-url.ts):
// read as the browser reads it (Fetch's data: URL processor), its text
// rewritten, and given back as a data: URL of the rewritten text under the
// same MIME type — a data: URL, so a CSP that admits data: and not blob:
// runs it as directly.

// DataURL is a data: URL as read: its MIME text as written (";base64"
// taken off) and its body's bytes.
type DataURL struct {
	Head string
	Body []byte
}

func isASCIIWS(c byte) bool { return c == '\t' || c == '\n' || c == '\f' || c == '\r' || c == ' ' }

// ReadDataURL reads a data: URL (an attribute value as written); false
// when it is none, does not read, or is outside the model — given as is.
func ReadDataURL(raw string) (DataURL, bool) {
	s := trimC0(raw)
	if strings.ContainsAny(s, "\t\n\r") || len(s) < 5 || !strings.EqualFold(s[:5], "data:") {
		return DataURL{}, false
	}
	rest := s[5:]
	if i := strings.IndexByte(rest, '#'); i >= 0 {
		rest = rest[:i]
	}
	ser := encodeC0(rest)
	comma := strings.IndexByte(ser, ',')
	if comma < 0 {
		return DataURL{}, false
	}
	mime := ser[:comma]
	if strings.IndexByte(mime, '?') >= 0 || !charsetOK(stripASCIIWS(mime)) {
		return DataURL{}, false
	}
	body := pctBytes(ser[comma+1:])
	head, b64 := base64Suffix(stripASCIIWS(mime))
	if !b64 {
		return DataURL{Head: head, Body: body}, true
	}
	dec, ok := forgivingBase64(string(body))
	if !ok {
		return DataURL{}, false
	}
	return DataURL{Head: head, Body: dec}, true
}

// trimC0 takes leading and trailing C0 controls and spaces off. A tab or
// newline left inside is outside the model (Chromium keeps them in some
// data: URLs, removes them in others): the URL is given as is.
func trimC0(s string) string {
	i, j := 0, len(s)
	for i < j && s[i] <= 0x20 {
		i++
	}
	for j > i && s[j-1] <= 0x20 {
		j--
	}
	return s[i:j]
}

// preprocessURL is the URL parser's: leading and trailing C0 controls and
// spaces off, tabs and newlines removed (Url.preprocess).
func preprocessURL(s string) string {
	i, j := 0, len(s)
	for i < j && s[i] <= 0x20 {
		i++
	}
	for j > i && s[j-1] <= 0x20 {
		j--
	}
	s = s[i:j]
	if strings.ContainsAny(s, "\t\n\r") {
		s = strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(s)
	}
	return s
}

// encodeC0 percent-encodes the C0 control percent-encode set (C0 controls
// and everything above '~'), UTF-8 bytes, upper-case hex.
func encodeC0(s string) string {
	var b strings.Builder
	const hex = "0123456789ABCDEF"
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < 0x20 || c > 0x7e {
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&15])
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

func dataHex(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

func pctBytes(s string) []byte {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			if a, ok := dataHex(s[i+1]); ok {
				if b, ok := dataHex(s[i+2]); ok {
					out = append(out, a<<4|b)
					i += 2
					continue
				}
			}
		}
		out = append(out, s[i])
	}
	return out
}

func stripASCIIWS(s string) string {
	i, j := 0, len(s)
	for i < j && isASCIIWS(s[i]) {
		i++
	}
	for j > i && isASCIIWS(s[j-1]) {
		j--
	}
	return s[i:j]
}

// base64Suffix takes ";" spaces* "base64" (any case) off the end.
func base64Suffix(m string) (string, bool) {
	if len(m) < 6 || !strings.EqualFold(m[len(m)-6:], "base64") {
		return m, false
	}
	r := strings.TrimRight(m[:len(m)-6], " ")
	if !strings.HasSuffix(r, ";") {
		return m, false
	}
	return r[:len(r)-1], true
}

// forgivingBase64 is Infra's forgiving-base64 decode.
func forgivingBase64(s string) ([]byte, bool) {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if !isASCIIWS(s[i]) {
			b.WriteByte(s[i])
		}
	}
	t := b.String()
	if len(t)%4 == 0 {
		if strings.HasSuffix(t, "==") {
			t = t[:len(t)-2]
		} else if strings.HasSuffix(t, "=") {
			t = t[:len(t)-1]
		}
	}
	if len(t)%4 == 1 {
		return nil, false
	}
	for i := 0; i < len(t); i++ {
		c := t[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '+' || c == '/') {
			return nil, false
		}
	}
	return lenientBase64(t), true
}

// lenientBase64 decodes validated base64 text, leftover bits discarded.
func lenientBase64(t string) []byte {
	val := func(c byte) uint32 {
		switch {
		case c >= 'A' && c <= 'Z':
			return uint32(c - 'A')
		case c >= 'a' && c <= 'z':
			return uint32(c-'a') + 26
		case c >= '0' && c <= '9':
			return uint32(c-'0') + 52
		case c == '+':
			return 62
		}
		return 63
	}
	var out []byte
	var acc uint32
	n := 0
	for i := 0; i < len(t); i++ {
		acc = acc<<6 | val(t[i])
		n += 6
		if n >= 8 {
			n -= 8
			out = append(out, byte(acc>>uint(n)))
			acc &= 1<<uint(n) - 1
		}
	}
	return out
}

// Rewritable: ASCII, or UTF-8 under no charset or charset=utf-8.
func (d DataURL) Rewritable() bool {
	ascii := true
	for _, b := range d.Body {
		if b >= 0x80 {
			ascii = false
			break
		}
	}
	if ascii {
		return true
	}
	h := strings.ToLower(d.Head)
	return utf8.Valid(d.Body) && (!strings.Contains(h, "charset=") || strings.Contains(h, "charset=utf-8"))
}

// Wrapped is "data:" <head> ";base64," <body, base64>.
func Wrapped(head string, body []byte) string {
	return "data:" + head + ";base64," + base64.StdEncoding.EncodeToString(body)
}

// RewriteDataScript is the URL a script given `raw` gets: a data: URL of
// its text rewritten by rewrite, or raw when it is no data: URL, does not
// read, is not rewritable or rewriting changes nothing.
func RewriteDataScript(raw string, rewrite func(text string) string) string {
	d, ok := ReadDataURL(raw)
	if !ok || !d.Rewritable() {
		return raw
	}
	text := string(d.Body)
	now := rewrite(text)
	if now == text {
		return raw
	}
	return Wrapped(d.Head, []byte(now))
}

// NamesScheme reports whether a URL string names its scheme (after the
// URL parser's preprocessing: an ASCII letter, then letters, digits, "+",
// "-", ".", then ":") — the only references that resolve against a base
// with an opaque path, such as a data: script's own URL.
func NamesScheme(raw string) bool {
	s := preprocessURL(raw)
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z':
		case i > 0 && (c >= '0' && c <= '9' || c == '+' || c == '-' || c == '.'):
		case i > 0 && c == ':':
			return true
		default:
			return false
		}
	}
	return false
}

// charsetOK is Chromium's own check (spec DataUrl.charsetOk): a "charset="
// parameter whose value is not an HTTP token makes the URL fail.
func charsetOK(h string) bool {
	for _, p := range strings.Split(h, ";") {
		p = stripASCIIWS(p)
		if len(p) >= 8 && strings.EqualFold(p[:8], "charset=") && !isToken(p[8:]) {
			return false
		}
	}
	return true
}

func isToken(v string) bool {
	if v == "" {
		return false
	}
	for i := 0; i < len(v); i++ {
		c := v[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("!#$%&'*+-.^_`|~", c) >= 0) {
			return false
		}
	}
	return true
}
