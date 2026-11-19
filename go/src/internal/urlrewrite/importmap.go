package urlrewrite

import (
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Import maps, as cyrano hands them to the browser: a port of
// spec/ImportMap.agda, which is the authority (TS: ts/client/src/url/
// import-map.ts; both checked against the spec, the spec's JSON reading
// against Chromium's JSON.parse).
//
// The map is edited as text: URL-like specifier keys and string addresses
// in "imports" and each scope, and every scope prefix, are replaced by their
// proxified form (JSON.stringify); "integrity"'s value becomes {};
// everything else is the page's own text. Text that is not a JSON object
// is left as written.

type jsonTK uint8

const (
	jWS jsonTK = iota
	jPunct
	jString
	jLit
)

type jsonTok struct {
	kind  jsonTK
	text  string
	value string
}

type imRole uint8

const (
	rKeep imRole = iota
	rSpecifier
	rPrefix
	rEmptyObj
	rDrop
)

func isJSONWS(c rune) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }
func isHexRune(c rune) bool {
	return c >= '0' && c <= '9' || c >= 'A' && c <= 'F' || c >= 'a' && c <= 'f'
}
func isLitRune(c rune) bool {
	return c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '+' || c == '-' || c == '.'
}

func validJSONNumber(s string) bool {
	i := 0
	if i < len(s) && s[i] == '-' {
		i++
	}
	digits := func() int {
		j := i
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
		}
		return i - j
	}
	if i < len(s) && s[i] == '0' {
		i++
	} else if digits() == 0 {
		return false
	}
	if i < len(s) && s[i] == '.' {
		i++
		if digits() == 0 {
			return false
		}
	}
	if i < len(s) && (s[i] == 'e' || s[i] == 'E') {
		i++
		if i < len(s) && (s[i] == '+' || s[i] == '-') {
			i++
		}
		if digits() == 0 {
			return false
		}
	}
	return i == len(s)
}

// jsonTokens reads JSON text into tokens (on code points); false when it is
// not JSON at the token level.
func jsonTokens(src string) ([]jsonTok, bool) {
	r := []rune(src)
	var out []jsonTok
	four := func(j int) (int, bool) {
		if j+4 > len(r) {
			return 0, false
		}
		for k := j; k < j+4; k++ {
			if !isHexRune(r[k]) {
				return 0, false
			}
		}
		n, _ := strconv.ParseUint(string(r[j:j+4]), 16, 32)
		return int(n), true
	}
	isHigh := func(n int) bool { return n > 55295 && n < 56320 }
	isLow := func(n int) bool { return n > 56319 && n < 57344 }
	for i := 0; i < len(r); {
		c := r[i]
		switch {
		case isJSONWS(c):
			j := i
			for j < len(r) && isJSONWS(r[j]) {
				j++
			}
			out = append(out, jsonTok{jWS, string(r[i:j]), ""})
			i = j
		case strings.ContainsRune("{}[]:,", c):
			out = append(out, jsonTok{jPunct, string(c), ""})
			i++
		case c == '"':
			var val []rune
			j, closed := i+1, false
			for j < len(r) {
				d := r[j]
				if d == '"' {
					closed = true
					j++
					break
				}
				if d < 32 {
					return nil, false
				}
				if d != '\\' {
					val = append(val, d)
					j++
					continue
				}
				if j+1 >= len(r) {
					return nil, false
				}
				e := r[j+1]
				if e == 'u' {
					n, ok := four(j + 2)
					if !ok {
						return nil, false
					}
					if isHigh(n) && j+7 < len(r) && r[j+6] == '\\' && r[j+7] == 'u' {
						if m, ok := four(j + 8); ok && isLow(m) {
							val = append(val, rune(65536+(n-55296)*1024+(m-56320)))
							j += 12
							continue
						}
					}
					val = append(val, rune(n))
					j += 6
					continue
				}
				simple := map[rune]rune{'"': '"', '\\': '\\', '/': '/', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t'}
				v, ok := simple[e]
				if !ok {
					return nil, false
				}
				val = append(val, v)
				j += 2
			}
			if !closed {
				return nil, false
			}
			out = append(out, jsonTok{jString, string(r[i:j]), runesToString(val)})
			i = j
		case isLitRune(c):
			j := i
			for j < len(r) && isLitRune(r[j]) {
				j++
			}
			t := string(r[i:j])
			if !(t == "true" || t == "false" || t == "null" || validJSONNumber(t)) {
				return nil, false
			}
			out = append(out, jsonTok{jLit, t, ""})
			i = j
		default:
			return nil, false
		}
	}
	return out, true
}

// runesToString keeps lone surrogates as code points (as the spec's
// strings do), each as its WTF-8-like rune — only compared, never written
// out as is (jsonStringify escapes them).
func runesToString(rs []rune) string {
	var b strings.Builder
	for _, c := range rs {
		if c >= 0xD800 && c <= 0xDFFF {
			b.WriteString(string([]byte{0xED, byte(0xA0 | (c>>6)&0x1F), byte(0x80 | c&0x3F)}))
			continue
		}
		b.WriteRune(c)
	}
	return b.String()
}

// importMapRoles gives each token its role (spec roles); false when the
// tokens are not a JSON object.
func importMapRoles(toks []jsonTok) (rs []imRole, ok bool) {
	rs = make([]imRole, len(toks))
	i := 0
	skip := func() {
		for i < len(toks) && toks[i].kind == jWS {
			i++
		}
	}
	isP := func(c string) bool { return i < len(toks) && toks[i].kind == jPunct && toks[i].text == c }
	type ctx uint8
	const (
		cTop ctx = iota
		cSpecifiers
		cScopes
		cOther
	)
	keyRole := func(c ctx) imRole {
		switch c {
		case cSpecifiers:
			return rSpecifier
		case cScopes:
			return rPrefix
		}
		return rKeep
	}
	valueRole := func(c ctx) imRole {
		if c == cSpecifiers {
			return rSpecifier
		}
		return rKeep
	}
	child := func(c ctx, key string) ctx {
		switch {
		case c == cTop && key == "imports":
			return cSpecifiers
		case c == cTop && key == "scopes":
			return cScopes
		case c == cScopes:
			return cSpecifiers
		}
		return cOther
	}
	defer func() {
		if recover() != nil {
			rs, ok = nil, false
		}
	}()
	fail := func() { panic("not JSON") }
	var value func(c ctx, asStr imRole)
	var object func(c ctx)
	var array func()
	value = func(c ctx, asStr imRole) {
		skip()
		if i >= len(toks) {
			fail()
		}
		switch t := toks[i]; {
		case t.kind == jString:
			rs[i] = asStr
			i++
		case t.kind == jLit:
			i++
		case isP("{"):
			i++
			object(c)
		case isP("["):
			i++
			array()
		default:
			fail()
		}
	}
	object = func(c ctx) {
		skip()
		if isP("}") {
			i++
			return
		}
		for {
			skip()
			if i >= len(toks) || toks[i].kind != jString {
				fail()
			}
			k := toks[i]
			rs[i] = keyRole(c)
			i++
			skip()
			if !isP(":") {
				fail()
			}
			i++
			skip()
			start := i
			value(child(c, k.value), valueRole(c))
			if c == cTop && k.value == "integrity" {
				rs[start] = rEmptyObj
				for j := start + 1; j < i; j++ {
					rs[j] = rDrop
				}
			}
			skip()
			if isP(",") {
				i++
				continue
			}
			if isP("}") {
				i++
				return
			}
			fail()
		}
	}
	array = func() {
		skip()
		if isP("]") {
			i++
			return
		}
		for {
			value(cOther, rKeep)
			skip()
			if isP(",") {
				i++
				continue
			}
			if isP("]") {
				i++
				return
			}
			fail()
		}
	}
	skip()
	if !isP("{") {
		return nil, false
	}
	i++
	object(cTop)
	skip()
	return rs, i == len(toks)
}

// jsonStringify is JSON.stringify of a string (lone surrogates escaped).
func jsonStringify(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for i := 0; i < len(s); {
		if s[i] == 0xED && i+2 < len(s) && s[i+1] >= 0xA0 {
			c := rune(s[i+1]&0x1F)<<6 | rune(s[i+2]&0x3F) | 0xD000
			b.WriteString(`\u` + strconv.FormatInt(int64(c), 16))
			i += 3
			continue
		}
		c, n := utf8.DecodeRuneInString(s[i:])
		i += n
		switch c {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if c < 32 {
				b.WriteString(`\u00`)
				if c < 16 {
					b.WriteByte('0')
				}
				b.WriteString(strconv.FormatInt(int64(c), 16))
			} else {
				b.WriteRune(c)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// RewriteImportMap rewrites an import map for the proxy (spec
// rewriteImportMap).
func RewriteImportMap(src []byte, base *url.URL, cfg ProxyConfig) []byte {
	return []byte(RewriteImportMapText(string(src), func(u string) string { return Rewrite(u, base, cfg) }))
}

// RewriteImportMapText is RewriteImportMap with the URL rewriter given.
func RewriteImportMapText(text string, rewrite func(string) string) string {
	toks, ok := jsonTokens(text)
	if !ok {
		return text
	}
	rs, ok := importMapRoles(toks)
	if !ok {
		return text
	}
	var b strings.Builder
	for i, t := range toks {
		switch rs[i] {
		case rKeep:
			b.WriteString(t.text)
		case rSpecifier:
			if !IsURLLikeSpecifier(t.value) {
				b.WriteString(t.text)
				break
			}
			if u := rewrite(t.value); u != t.value {
				b.WriteString(jsonStringify(u))
			} else {
				b.WriteString(t.text)
			}
		case rPrefix:
			if u := rewrite(t.value); u != t.value {
				b.WriteString(jsonStringify(u))
			} else {
				b.WriteString(t.text)
			}
		case rEmptyObj:
			b.WriteString("{}")
		case rDrop:
		}
	}
	return b.String()
}
