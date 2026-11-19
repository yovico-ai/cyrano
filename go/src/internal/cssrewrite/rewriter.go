// Package cssrewrite rewrites every URL in CSS text so it points back at
// the proxy.
//
// A port of spec/Css.agda, which is the authority — keep this in step with
// it and with ts/client/src/css/rewriter.ts (both checked against the spec;
// the spec against Chromium: ts/client/tests/spec/css-vs-chromium). CSS
// Syntax 3 §4 tokenization as far as finding URLs needs it, on code points,
// newlines read where they stand, so untouched text comes back byte for
// byte.
//
// URLs: a url token; the first string directly inside url(); the string
// after @import; a string directly inside image-set(). One that containment
// keeps as written keeps its exact text; any other is written url("…") /
// "…" (CSSOM serialize a string).
package cssrewrite

import (
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// Options configures one rewrite call.
type Options struct {
	BaseURL *url.URL
	Proxy   urlrewrite.ProxyConfig
	Logger  *slog.Logger // unused: the tokenizer cannot fail
}

// Rewrite returns src with every URL routed through the proxy
// (spec rewriteCss over urlrewrite.Rewrite).
func Rewrite(src []byte, opts Options) []byte {
	if opts.BaseURL == nil || len(src) == 0 {
		return src
	}
	return []byte(RewriteText(string(src), func(u string) string {
		return urlrewrite.Rewrite(u, opts.BaseURL, opts.Proxy)
	}))
}

type kind uint8

const (
	kWS kind = iota
	kComment
	kString
	kBadString
	kURL
	kBadURL
	kFunction
	kAtKeyword
	kIdent
	kOther
)

type tok struct {
	kind  kind
	text  string // the input's own text
	value string // a string's or url's value; a name's, lowercased
}

// tokenizer works on the code points of s; off[i] is the byte offset of
// code point i (off[len(r)] = len(s)).
type tokenizer struct {
	s   string
	r   []rune
	off []int
}

func newTokenizer(s string) *tokenizer {
	t := &tokenizer{s: s}
	for i := 0; i < len(s); {
		c, n := utf8.DecodeRuneInString(s[i:])
		t.r = append(t.r, c)
		t.off = append(t.off, i)
		i += n
	}
	t.off = append(t.off, len(s))
	return t
}

func (t *tokenizer) at(i int) rune {
	if i < 0 || i >= len(t.r) {
		return -1
	}
	return t.r[i]
}

// text is the input's own bytes for code points [i, j).
func (t *tokenizer) text(i, j int) string { return t.s[t.off[i]:t.off[j]] }

func isNewline(c rune) bool    { return c == '\n' || c == '\r' || c == '\f' }
func isWhitespace(c rune) bool { return isNewline(c) || c == '\t' || c == ' ' }
func isDigit(c rune) bool      { return c >= '0' && c <= '9' }
func isHex(c rune) bool        { return isDigit(c) || c >= 'A' && c <= 'F' || c >= 'a' && c <= 'f' }
func isAlpha(c rune) bool      { return c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' }
func isIdentStart(c rune) bool { return isAlpha(c) || c == '_' || c > 127 }
func isNameChar(c rune) bool   { return isIdentStart(c) || isDigit(c) || c == '-' }
func isNonPrintable(c rune) bool {
	return c >= 0 && c <= 8 || c == 11 || c >= 14 && c <= 31 || c == 127
}

func lowerASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

func (t *tokenizer) validEscape(i int) bool { return t.at(i) == '\\' && !isNewline(t.at(i+1)) }

func (t *tokenizer) startsIdent(i int) bool {
	if t.at(i) == '-' {
		return isIdentStart(t.at(i+1)) || t.at(i+1) == '-' || t.validEscape(i+1)
	}
	return isIdentStart(t.at(i)) || t.validEscape(i)
}

func (t *tokenizer) startsNumber(i int) bool {
	c, d, e := t.at(i), t.at(i+1), t.at(i+2)
	switch c {
	case '+', '-':
		return isDigit(d) || d == '.' && isDigit(e)
	case '.':
		return isDigit(d)
	}
	return isDigit(c)
}

// escape reads an escape after its backslash at i: its value, the next index.
func (t *tokenizer) escape(i int) (string, int) {
	if i >= len(t.r) {
		return "�", i
	}
	if !isHex(t.r[i]) {
		return string(t.r[i]), i + 1
	}
	j, n := i, 0
	for j < len(t.r) && j-i < 6 && isHex(t.r[j]) {
		v, _ := strconv.ParseUint(string(t.r[j]), 16, 8)
		n = n*16 + int(v)
		j++
	}
	if t.at(j) == '\r' && t.at(j+1) == '\n' {
		j += 2
	} else if isWhitespace(t.at(j)) {
		j++
	}
	if n == 0 || n > 55295 && n < 57344 || n > 1114111 {
		return "�", j
	}
	return string(rune(n)), j
}

func (t *tokenizer) name(i int) (string, int) {
	var val strings.Builder
	for i < len(t.r) {
		if t.r[i] == '\\' {
			if !t.validEscape(i) {
				break
			}
			v, j := t.escape(i + 1)
			val.WriteString(v)
			i = j
		} else if isNameChar(t.r[i]) {
			val.WriteRune(t.r[i])
			i++
		} else {
			break
		}
	}
	return val.String(), i
}

func (t *tokenizer) dropWS(i int) int {
	for i < len(t.r) && isWhitespace(t.r[i]) {
		i++
	}
	return i
}

func (t *tokenizer) remnants(i int) int {
	for i < len(t.r) {
		if t.r[i] == ')' {
			return i + 1
		}
		if t.r[i] == '\\' && t.validEscape(i) {
			_, i = t.escape(i + 1)
		} else {
			i++
		}
	}
	return i
}

// str reads a string after its opening quote q: value, next, ok.
func (t *tokenizer) str(i int, q rune) (string, int, bool) {
	var val strings.Builder
	for i < len(t.r) {
		c := t.r[i]
		switch {
		case c == q:
			return val.String(), i + 1, true
		case isNewline(c):
			return val.String(), i, false
		case c == '\\':
			if i+1 >= len(t.r) {
				return val.String(), i + 1, true
			}
			if t.r[i+1] == '\r' && t.at(i+2) == '\n' {
				i += 3
				continue
			}
			if isNewline(t.r[i+1]) {
				i += 2
				continue
			}
			v, j := t.escape(i + 1)
			val.WriteString(v)
			i = j
		default:
			val.WriteRune(c)
			i++
		}
	}
	return val.String(), i, true
}

// urlBody reads a url token's body after "url(" and its whitespace.
func (t *tokenizer) urlBody(i int) (string, int, bool) {
	var val strings.Builder
	for i < len(t.r) {
		c := t.r[i]
		switch {
		case c == ')':
			return val.String(), i + 1, true
		case isWhitespace(c):
			j := t.dropWS(i)
			if j >= len(t.r) {
				return val.String(), j, true
			}
			if t.r[j] == ')' {
				return val.String(), j + 1, true
			}
			return "", t.remnants(j), false
		case c == '"' || c == '\'' || c == '(' || isNonPrintable(c):
			return "", t.remnants(i), false
		case c == '\\':
			if !t.validEscape(i) {
				return "", t.remnants(i), false
			}
			v, j := t.escape(i + 1)
			val.WriteString(v)
			i = j
		default:
			val.WriteRune(c)
			i++
		}
	}
	return val.String(), i, true
}

func (t *tokenizer) number(i int) int {
	if t.at(i) == '+' || t.at(i) == '-' {
		i++
	}
	for isDigit(t.at(i)) {
		i++
	}
	if t.at(i) == '.' && isDigit(t.at(i+1)) {
		i++
		for isDigit(t.at(i)) {
			i++
		}
	}
	e := t.at(i)
	if (e == 'e' || e == 'E') && (t.at(i+1) == '+' || t.at(i+1) == '-') && isDigit(t.at(i+2)) {
		i += 2
		for isDigit(t.at(i)) {
			i++
		}
	} else if (e == 'e' || e == 'E') && isDigit(t.at(i+1)) {
		i++
		for isDigit(t.at(i)) {
			i++
		}
	}
	return i
}

func (t *tokenizer) token(i int) (tok, int) {
	c := t.r[i]
	switch {
	case c == '/' && t.at(i+1) == '*':
		j := i + 2
		for j < len(t.r) && !(t.r[j] == '*' && t.at(j+1) == '/') {
			j++
		}
		j += 2
		if j > len(t.r) {
			j = len(t.r)
		}
		return tok{kComment, t.text(i, j), ""}, j
	case isWhitespace(c):
		j := t.dropWS(i)
		return tok{kWS, t.text(i, j), ""}, j
	case c == '"' || c == '\'':
		v, j, ok := t.str(i+1, c)
		if !ok {
			return tok{kBadString, t.text(i, j), ""}, j
		}
		return tok{kString, t.text(i, j), v}, j
	case c == '#' && (isNameChar(t.at(i+1)) || t.validEscape(i+1)):
		_, j := t.name(i + 1)
		return tok{kOther, t.text(i, j), ""}, j
	case (c == '+' || c == '-' || c == '.') && t.startsNumber(i) || isDigit(c):
		j := t.number(i)
		if t.startsIdent(j) {
			_, j = t.name(j)
		}
		return tok{kOther, t.text(i, j), ""}, j
	case c == '-' && t.at(i+1) == '-' && t.at(i+2) == '>':
		return tok{kOther, t.text(i, i+3), ""}, i + 3
	case c == '@' && t.startsIdent(i+1):
		v, j := t.name(i + 1)
		return tok{kAtKeyword, t.text(i, j), lowerASCII(v)}, j
	case t.startsIdent(i):
		return t.identLike(i)
	}
	return tok{kOther, t.text(i, i+1), ""}, i + 1
}

func (t *tokenizer) identLike(i int) (tok, int) {
	v, j := t.name(i)
	if t.at(j) != '(' {
		return tok{kIdent, t.text(i, j), lowerASCII(v)}, j
	}
	if lowerASCII(v) == "url" {
		k := j + 1
		for isWhitespace(t.at(k)) {
			k++
		}
		if t.at(k) != '"' && t.at(k) != '\'' {
			m := t.dropWS(j + 1)
			uv, n, ok := t.urlBody(m)
			if !ok {
				return tok{kBadURL, t.text(i, n), ""}, n
			}
			return tok{kURL, t.text(i, n), uv}, n
		}
	}
	return tok{kFunction, t.text(i, j+1), lowerASCII(v)}, j + 1
}

func tokenize(s string) []tok {
	t := newTokenizer(s)
	var out []tok
	for i := 0; i < len(t.r); {
		tk, j := t.token(i)
		out = append(out, tk)
		if j <= i {
			j = i + 1
		}
		i = j
	}
	return out
}

type role uint8

const (
	plain role = iota
	asURL
	asString
)

// roles marks which tokens are URLs (spec roles).
func roles(toks []tok) []role {
	out := make([]role, len(toks))
	imp := false
	var stack []string // innermost last: a function's name, or "" for ( [ {
	top := func() string {
		if len(stack) == 0 {
			return ""
		}
		return stack[len(stack)-1]
	}
	for i, t := range toks {
		switch t.kind {
		case kWS, kComment:
		case kURL:
			out[i] = asURL
			imp = false
		case kString:
			f := top()
			if imp || f == "url" || f == "image-set" || f == "-webkit-image-set" {
				out[i] = asString
			}
			imp = false
			if f == "url" {
				stack[len(stack)-1] = "url-used"
			}
		case kAtKeyword:
			imp = t.value == "import"
		case kFunction:
			imp = false
			stack = append(stack, t.value)
		default:
			imp = false
			switch t.text {
			case "(", "[", "{":
				stack = append(stack, "")
			case ")", "]", "}":
				if len(stack) > 0 {
					stack = stack[:len(stack)-1]
				}
			}
		}
	}
	return out
}

// serializeString is CSSOM "serialize a string".
func serializeString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, c := range s {
		switch {
		case c == 0:
			b.WriteRune('�')
		case c >= 1 && c <= 31 || c == 127:
			b.WriteString("\\" + strconv.FormatInt(int64(c), 16) + " ")
		case c == '"' || c == '\\':
			b.WriteByte('\\')
			b.WriteRune(c)
		default:
			b.WriteRune(c)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// URLs is what a stylesheet names, in order (spec cssUrls).
func URLs(s string) []string {
	toks := tokenize(s)
	rs := roles(toks)
	var out []string
	for i, t := range toks {
		if rs[i] != plain {
			out = append(out, t.value)
		}
	}
	return out
}

// RewriteText rewrites every URL in CSS text (spec rewriteCss): rewrite
// gives a URL's proxified form; one it returns unchanged is kept as written.
func RewriteText(s string, rewrite func(string) string) string {
	toks := tokenize(s)
	rs := roles(toks)
	var b strings.Builder
	b.Grow(len(s) + len(s)/8)
	for i, t := range toks {
		if rs[i] == plain {
			b.WriteString(t.text)
			continue
		}
		u := rewrite(t.value)
		if u == t.value {
			b.WriteString(t.text)
			continue
		}
		if rs[i] == asURL {
			b.WriteString("url(" + serializeString(u) + ")")
		} else {
			b.WriteString(serializeString(u))
		}
	}
	return b.String()
}
