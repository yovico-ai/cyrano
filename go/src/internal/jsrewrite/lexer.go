package jsrewrite

import (
	"unicode/utf8"
)

// The JavaScript scanner of the recognizer (recognizer.go).
//
// It yields tokens with their byte offsets and nothing else: no values, no
// allocation. Three things a scanner cannot decide alone are left to the
// parser, which knows where it is in the grammar:
//
//   - `/` is scanned as a punctuator; where an operand is expected the
//     parser calls regex() to re-scan it as a regular-expression literal;
//   - a template is scanned up to its first `${`; after the expression the
//     parser calls templateContinue() at the closing `}`;
//   - words are all tIdent — which are keywords depends on context.

type tokKind uint8

const (
	tEOF tokKind = iota
	tIdent
	tPrivate      // #name
	tNum          // any numeric literal
	tStr          // '…' or "…"
	tTemplate     // `…` with no substitution
	tTemplateHead // `…${
	tTemplateMid  // }…${
	tTemplateTail // }…`
	tRegex
	tPunct
)

type token struct {
	kind       tokKind
	start, end int
	nl         bool // a line terminator precedes it (since the previous token)
}

type lexer struct {
	src     []byte
	pos     int
	tok     token
	prevEnd int // end of the previous token
}

type scanError struct{ at int }

// fail aborts the scan (and the parse): recovered in jsEdits.
func (l *lexer) fail() { panic(scanError{l.pos}) }

func isIdentStart(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '$' || c == '_' || c == '\\' || c >= 0x80
}

func isIdentPart(c byte) bool {
	return isIdentStart(c) || c >= '0' && c <= '9'
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// unicodeSpace classifies a non-ASCII rune: 1 whitespace, 2 line terminator.
func unicodeSpace(r rune) int {
	switch r {
	case 0x2028, 0x2029:
		return 2
	case 0xa0, 0xfeff, 0x1680, 0x202f, 0x205f, 0x3000:
		return 1
	}
	if r >= 0x2000 && r <= 0x200a {
		return 1
	}
	return 0
}

// skipTrivia moves past whitespace and comments; reports whether a line
// terminator was among them.
func (l *lexer) skipTrivia() bool {
	src := l.src
	// Only trivia lies between the last line terminator seen here (or the
	// start of the script) and l.pos: where `-->` begins a comment.
	lineStart := l.pos == 0
	sawNL := false
	for l.pos < len(src) {
		c := src[l.pos]
		switch {
		case c == ' ' || c == '\t' || c == '\v' || c == '\f':
			l.pos++
		case c == '\n' || c == '\r':
			l.pos++
			sawNL, lineStart = true, true
		case c == '/' && l.pos+1 < len(src) && src[l.pos+1] == '/':
			l.lineComment()
		case c == '/' && l.pos+1 < len(src) && src[l.pos+1] == '*':
			l.pos += 2
			for {
				if l.pos+1 >= len(src) {
					l.fail()
				}
				if src[l.pos] == '*' && src[l.pos+1] == '/' {
					l.pos += 2
					break
				}
				if src[l.pos] == '\n' || src[l.pos] == '\r' {
					sawNL, lineStart = true, true
				} else if src[l.pos] == 0xe2 && l.pos+2 < len(src) && src[l.pos+1] == 0x80 && (src[l.pos+2] == 0xa8 || src[l.pos+2] == 0xa9) {
					sawNL, lineStart = true, true
				}
				l.pos++
			}
		case c == '<' && l.pos+3 < len(src) && src[l.pos+1] == '!' && src[l.pos+2] == '-' && src[l.pos+3] == '-':
			l.lineComment() // <!-- : an HTML-like comment (scripts, Annex B)
		case c == '-' && lineStart && l.pos+2 < len(src) && src[l.pos+1] == '-' && src[l.pos+2] == '>':
			l.lineComment() // --> at the start of a line
		case c == '#' && l.pos == 0 && len(src) > 1 && src[1] == '!':
			l.lineComment() // hashbang
		case c >= 0x80:
			r, n := utf8.DecodeRune(src[l.pos:])
			switch unicodeSpace(r) {
			case 1:
				l.pos += n
			case 2:
				l.pos += n
				sawNL, lineStart = true, true
			default:
				return sawNL
			}
		default:
			return sawNL
		}
	}
	return sawNL
}

func (l *lexer) lineComment() {
	src := l.src
	for l.pos < len(src) {
		c := src[l.pos]
		if c == '\n' || c == '\r' {
			return
		}
		if c == 0xe2 && l.pos+2 < len(src) && src[l.pos+1] == 0x80 && (src[l.pos+2] == 0xa8 || src[l.pos+2] == 0xa9) {
			return
		}
		l.pos++
	}
}

// next scans the next token into l.tok.
func (l *lexer) next() {
	l.prevEnd = l.tok.end
	nl := l.skipTrivia()
	src := l.src
	start := l.pos
	if start >= len(src) {
		l.tok = token{kind: tEOF, start: start, end: start, nl: nl}
		return
	}
	c := src[start]
	kind := tPunct
	switch {
	case isIdentStart(c):
		l.identRest()
		kind = tIdent
	case isDigit(c) || c == '.' && start+1 < len(src) && isDigit(src[start+1]):
		l.number()
		kind = tNum
	case c == '"' || c == '\'':
		l.str(c)
		kind = tStr
	case c == '`':
		l.pos++
		kind = tTemplate
		if l.templateChars() {
			kind = tTemplateHead
		}
	case c == '#':
		l.pos++
		if l.pos >= len(src) || !isIdentStart(src[l.pos]) {
			l.fail()
		}
		l.identRest()
		kind = tPrivate
	default:
		n := punctLen(src, start)
		if n == 0 {
			l.fail()
		}
		l.pos = start + n
	}
	l.tok = token{kind: kind, start: start, end: l.pos, nl: nl}
}

func (l *lexer) identRest() {
	src := l.src
	for l.pos < len(src) {
		c := src[l.pos]
		if c == '\\' { // \uXXXX or \u{…}
			l.pos++
			if l.pos >= len(src) || src[l.pos] != 'u' {
				l.fail()
			}
			l.pos++
			if l.pos < len(src) && src[l.pos] == '{' {
				for l.pos < len(src) && src[l.pos] != '}' {
					l.pos++
				}
				l.pos++
			} else {
				l.pos += 4
			}
			if l.pos > len(src) {
				l.fail()
			}
			continue
		}
		if c >= 0x80 {
			r, n := utf8.DecodeRune(src[l.pos:])
			if unicodeSpace(r) != 0 {
				return
			}
			l.pos += n
			continue
		}
		if !isIdentPart(c) {
			return
		}
		l.pos++
	}
}

func (l *lexer) number() {
	src := l.src
	alnum := func() {
		for l.pos < len(src) && (isDigit(src[l.pos]) || src[l.pos] == '_' || src[l.pos] >= 'a' && src[l.pos] <= 'z' || src[l.pos] >= 'A' && src[l.pos] <= 'Z') {
			l.pos++
		}
	}
	digits := func() {
		for l.pos < len(src) && (isDigit(src[l.pos]) || src[l.pos] == '_') {
			l.pos++
		}
	}
	if src[l.pos] == '0' && l.pos+1 < len(src) {
		switch src[l.pos+1] {
		case 'x', 'X', 'b', 'B', 'o', 'O':
			l.pos += 2
			alnum()
			return
		}
	}
	digits()
	if l.pos < len(src) && src[l.pos] == '.' {
		l.pos++
		digits()
	}
	if l.pos < len(src) && (src[l.pos] == 'e' || src[l.pos] == 'E') {
		p := l.pos + 1
		if p < len(src) && (src[p] == '+' || src[p] == '-') {
			p++
		}
		if p < len(src) && isDigit(src[p]) {
			l.pos = p
			digits()
		}
	}
	if l.pos < len(src) && src[l.pos] == 'n' {
		l.pos++
	}
}

func (l *lexer) str(quote byte) {
	src := l.src
	l.pos++
	for l.pos < len(src) {
		c := src[l.pos]
		switch c {
		case quote:
			l.pos++
			return
		case '\\':
			l.pos += 2
			// \ CR LF is one continuation
			if l.pos < len(src) && src[l.pos-1] == '\r' && src[l.pos] == '\n' {
				l.pos++
			}
		case '\n', '\r':
			l.fail()
		default:
			l.pos++
		}
	}
	l.fail()
}

// templateChars scans template characters from l.pos to the closing
// backtick (false) or past a `${` (true).
func (l *lexer) templateChars() bool {
	src := l.src
	for l.pos < len(src) {
		switch src[l.pos] {
		case '`':
			l.pos++
			return false
		case '\\':
			l.pos += 2
		case '$':
			if l.pos+1 < len(src) && src[l.pos+1] == '{' {
				l.pos += 2
				return true
			}
			l.pos++
		default:
			l.pos++
		}
	}
	l.fail()
	return false
}

// templateContinue re-scans the current `}` token as the continuation of a
// template: its middle (another `${` follows) or its tail.
func (l *lexer) templateContinue() {
	l.pos = l.tok.start + 1
	kind := tTemplateTail
	if l.templateChars() {
		kind = tTemplateMid
	}
	l.tok.kind, l.tok.end = kind, l.pos
}

// regex re-scans the current `/` or `/=` token as a regular-expression
// literal.
func (l *lexer) regex() {
	src := l.src
	l.pos = l.tok.start + 1
	inClass := false
	for {
		if l.pos >= len(src) {
			l.fail()
		}
		c := src[l.pos]
		switch {
		case c == '\n' || c == '\r':
			l.fail()
		case c == '\\':
			l.pos += 2
			continue
		case c == '[':
			inClass = true
		case c == ']':
			inClass = false
		case c == '/' && !inClass:
			l.pos++
			for l.pos < len(src) && isIdentPart(src[l.pos]) && src[l.pos] != '\\' {
				l.pos++
			}
			l.tok.kind, l.tok.end = tRegex, l.pos
			return
		}
		l.pos++
	}
}

// punctLen is the length of the punctuator at src[i:], 0 if there is none.
func punctLen(src []byte, i int) int {
	at := func(k int) byte {
		if i+k < len(src) {
			return src[i+k]
		}
		return 0
	}
	switch src[i] {
	case '{', '}', '(', ')', '[', ']', ';', ',', '~', ':', '@':
		return 1
	case '.':
		if at(1) == '.' && at(2) == '.' {
			return 3
		}
		return 1
	case '?':
		if at(1) == '?' {
			if at(2) == '=' {
				return 3
			}
			return 2
		}
		if at(1) == '.' && !isDigit(at(2)) {
			return 2
		}
		return 1
	case '<':
		if at(1) == '<' {
			if at(2) == '=' {
				return 3
			}
			return 2
		}
		if at(1) == '=' {
			return 2
		}
		return 1
	case '>':
		if at(1) == '>' {
			if at(2) == '>' {
				if at(3) == '=' {
					return 4
				}
				return 3
			}
			if at(2) == '=' {
				return 3
			}
			return 2
		}
		if at(1) == '=' {
			return 2
		}
		return 1
	case '=':
		if at(1) == '=' {
			if at(2) == '=' {
				return 3
			}
			return 2
		}
		if at(1) == '>' {
			return 2
		}
		return 1
	case '!':
		if at(1) == '=' {
			if at(2) == '=' {
				return 3
			}
			return 2
		}
		return 1
	case '+', '-':
		if at(1) == src[i] || at(1) == '=' {
			return 2
		}
		return 1
	case '*':
		if at(1) == '*' {
			if at(2) == '=' {
				return 3
			}
			return 2
		}
		if at(1) == '=' {
			return 2
		}
		return 1
	case '/', '%', '^':
		if at(1) == '=' {
			return 2
		}
		return 1
	case '&', '|':
		if at(1) == src[i] {
			if at(2) == '=' {
				return 3
			}
			return 2
		}
		if at(1) == '=' {
			return 2
		}
		return 1
	}
	return 0
}
