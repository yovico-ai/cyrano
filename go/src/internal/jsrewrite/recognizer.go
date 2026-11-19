package jsrewrite

// The JavaScript recognizer: a recursive-descent parser for the whole
// language that builds no tree. What it produces is the list of edits the
// rewriting rules call for, each at an exact byte offset of the source
// (edits.go) — the rules themselves are stated once, in the TS reference
// (ts/client/src/js/rewriter.ts, R1…R11), and this file must produce the
// same edits; the two are compared on a corpus of real scripts.
//
// Why our own: the rules need to know, for every member access, where its
// object begins and ends, and for every identifier whether it is read,
// assigned or declared. A scanner cannot tell; a general-purpose AST can,
// but the Go parsers at hand either keep no positions or do not parse the
// whole language.
//
// It is a recognizer, not a validator: it accepts some programs a browser
// would reject (it never checks early errors), and any script a browser
// accepts must be accepted here. A script it cannot parse is left alone.
//
// Three places need more than one token of context, and are handled by
// deferring rather than by look-ahead:
//
//   - a lone identifier is not "read" until something consumes it as a
//     value (expr.lone; read()) — it may turn out to be an assignment
//     target, an arrow function's parameter, the callee of a direct eval;
//   - `(a, b)`, `[a, b]` and `{a, b}` may turn out to be an arrow
//     function's parameters or a destructuring target once `=>` or `=`
//     follows: the identifier edits made inside them are kept in a patScope
//     and withdrawn (or turned into assignments) if so;
//   - the head of a for statement may turn out to be for-in / for-of.

import (
	"bytes"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// Identifier names the rules care about.
const (
	idNone uint8 = iota
	idOther
	idLocation
	idTop
	idParent
	idEval
	idAsync
	idWorker
	idSharedWorker
)

// Literal kinds of a single-token expression (a constant member key).
const (
	litNone uint8 = iota
	litString
	litTemplate
	litOther
)

// expr is what parsing an expression leaves behind: its extent, and the
// few facts the rules ask about it.
type expr struct {
	start, end int
	lone       uint8     // the expression is exactly this identifier, not yet read
	lit        uint8     // the expression is exactly one literal token
	chain      bool      // part of an optional chain that can short-circuit
	wrapped    bool      // as rewritten, it starts with a call (R11)
	super      bool      // `super`
	meta       bool      // `import.meta`
	pat        *patScope // the expression is exactly a (…), […] or {…}
	paren      bool      // … and it is a parenthesized group
}

// patItem is an identifier edited inside a possible pattern.
type patItem struct {
	e0, e1     int   // its edits: p.edits[e0:e1]
	start, end int   // the identifier
	name       uint8 // id…
	shorthand  bool  // {id} or {id = d}
	target     bool  // already edited as an assignment target
}

type patScope struct{ items []patItem }

type fnState struct{ async, generator bool }

type parser struct {
	lexer
	o     *Options
	edits []edit
	seq   int

	noIn    bool // `in` is not an operator here (a for statement's head)
	forInit bool // … and a trailing `in` / `of` ends the expression unread
	fn      fnState
	depth   int // function nesting
	// withDepth > 0: inside a with body, where the runtime is reached
	// through the global object (R13).
	withDepth int
	scope     *patScope // the possible pattern being parsed
	nest      int       // recursion depth
}

type parseError struct{ at int }

const maxNesting = 2500

func (p *parser) failAt() { panic(parseError{p.tok.start}) }

func (p *parser) enter() {
	p.nest++
	if p.nest > maxNesting {
		p.failAt()
	}
}

// ── tokens ─────────────────────────────────────────────────────────────

func (p *parser) text() []byte { return p.src[p.tok.start:p.tok.end] }

// is: the current token is the punctuator s.
func (p *parser) is(s string) bool {
	return p.tok.kind == tPunct && p.tok.end-p.tok.start == len(s) && string(p.src[p.tok.start:p.tok.end]) == s
}

// word: the current token is the identifier or keyword s (written plainly).
func (p *parser) word(s string) bool {
	return p.tok.kind == tIdent && p.tok.end-p.tok.start == len(s) && string(p.src[p.tok.start:p.tok.end]) == s
}

func (p *parser) eat(s string) bool {
	if p.is(s) {
		p.next()
		return true
	}
	return false
}

func (p *parser) expect(s string) {
	if !p.is(s) {
		p.failAt()
	}
	p.next()
}

func (p *parser) eatWord(s string) bool {
	if p.word(s) {
		p.next()
		return true
	}
	return false
}

// peek is the token after the current one (scanned as in operator position).
func (p *parser) peek() token {
	pos, tok, prevEnd := p.pos, p.tok, p.prevEnd
	p.next()
	t := p.tok
	p.pos, p.tok, p.prevEnd = pos, tok, prevEnd
	return t
}

func (p *parser) peekIs(s string) bool {
	t := p.peek()
	return t.kind == tPunct && string(p.src[t.start:t.end]) == s
}

func (p *parser) semicolon() { p.eat(";") }

// identName decodes an identifier token's name (it may contain \u escapes).
func identName(raw []byte) string {
	if bytes.IndexByte(raw, '\\') < 0 {
		return string(raw)
	}
	var b strings.Builder
	for i := 0; i < len(raw); {
		if raw[i] == '\\' && i+1 < len(raw) && raw[i+1] == 'u' {
			r, n := unicodeEscape(raw[i+2:])
			b.WriteRune(r)
			i += 2 + n
			continue
		}
		b.WriteByte(raw[i])
		i++
	}
	return b.String()
}

// unicodeEscape decodes what follows `\u`: XXXX or {X…}. Returns the rune
// and the bytes consumed.
func unicodeEscape(s []byte) (rune, int) {
	if len(s) > 0 && s[0] == '{' {
		end := bytes.IndexByte(s, '}')
		if end < 0 {
			return utf8.RuneError, len(s)
		}
		v, err := strconv.ParseUint(string(s[1:end]), 16, 32)
		if err != nil {
			return utf8.RuneError, end + 1
		}
		return rune(v), end + 1
	}
	if len(s) < 4 {
		return utf8.RuneError, len(s)
	}
	v, err := strconv.ParseUint(string(s[:4]), 16, 32)
	if err != nil {
		return utf8.RuneError, 4
	}
	return rune(v), 4
}

func identCode(name string) uint8 {
	switch name {
	case "location":
		return idLocation
	case "top":
		return idTop
	case "parent":
		return idParent
	case "eval":
		return idEval
	case "async":
		return idAsync
	case "Worker":
		return idWorker
	case "SharedWorker":
		return idSharedWorker
	}
	return idOther
}

// ── rules ──────────────────────────────────────────────────────────────

const setLocation = "$rewriter.wrap_set_location(location, function(v){location=v;}).value"

// identHelper is R1's helper for a bare identifier that is read.
func (p *parser) identHelper(id uint8) string {
	switch id {
	case idLocation:
		if p.o.WrapGetLocation {
			return "wrap_get_location"
		}
	case idTop:
		if p.o.WrapGetTopWindow {
			return "wrap_get_top_window"
		}
	case idParent:
		if p.o.WrapGetParentWindow {
			return "wrap_get_top_window"
		}
	case idEval:
		if p.o.WrapEval {
			return "wrap_eval"
		}
	}
	return ""
}

// memberHelper is R3's helper for X.name; write/writeln/postMessage only where called.
func (p *parser) memberHelper(name string, called bool) string {
	switch name {
	case "location":
		if p.o.WrapLocation {
			return "wrap_location"
		}
	case "top":
		if p.o.WrapTopWindow {
			return "wrap_top_window"
		}
	case "parent":
		if p.o.WrapParentWindow {
			return "wrap_parent_window"
		}
	case "write", "writeln":
		if called && p.o.WrapDocumentWrite {
			return "wrap_document_write"
		}
	case "postMessage":
		// The calling window's runtime learns that it is the sender.
		if called && p.o.WrapPostMessage {
			return "wrap_postMessage"
		}
	}
	return ""
}

// read marks e as consumed for its value: R1 if it is a bare identifier.
func (p *parser) read(e *expr) {
	if e.lone >= idLocation && e.lone <= idEval {
		if h := p.identHelper(e.lone); h != "" {
			p.open(e.start, "$rewriter."+h+"(")
			p.close(e.end, ")")
			e.wrapped = true
		}
	}
	e.lone = idNone
}

// member applies R3, R4 or R5 to obj.name / obj[key]. name is the constant
// key ("" with static false: a key computed at run time). Reports whether a
// rule applied.
func (p *parser) member(obj *expr, name string, static, computed, optional bool, opPos, lb, rb int, called bool) bool {
	if obj.super {
		return false
	}
	inChain := optional || obj.chain
	if static {
		if h := p.memberHelper(name, called); h != "" { // R3
			p.open(obj.start, "$rewriter."+h+"({obj:")
			if inChain {
				p.close(obj.end, ",opt:1})")
				if !optional {
					// `?.` must be one token: the `.` is replaced, not prefixed.
					if computed {
						p.replace(lb, 0, "?.")
					} else {
						p.replace(opPos, 1, "?.")
					}
				}
			} else {
				p.close(obj.end, "})")
			}
			return true
		}
		if name == "eval" && p.o.WrapEvalMemexp && !inChain { // R4
			p.open(obj.start, "$rewriter.wrap_eval_memexp(")
			p.close(obj.end, ")")
			return true
		}
		return false
	}
	if !inChain && p.o.WrapMemberExpression && (p.o.DebugR5At == nil || p.o.DebugR5At(lb)) { // R5
		p.open(obj.start, "$rewriter.wrap_member_expression(")
		p.replace(lb, 1, ",$__crn_key__=(")
		p.replace(rb, 1, "))[$__crn_key__]")
		return true
	}
	return false
}

// specifier applies R8 (and the literal case of R7) to the string-literal
// token [start,end): proxified in place. False when it is left alone.
func (p *parser) specifier(start, end int) bool {
	if p.o.BaseURL == nil || p.o.ProxifyURL == nil {
		return false
	}
	value, ok := stringValue(p.src[start:end])
	// A bare specifier ("react") is not a URL: the page's import map
	// resolves it.
	if !ok || !urlrewrite.IsURLLikeSpecifier(value) {
		return false
	}
	to := p.o.ProxifyURL(value, p.o.BaseURL)
	if to == value {
		return false
	}
	p.replace(start, end-start, jsonString(to))
	return true
}

// ── possible patterns ──────────────────────────────────────────────────

func (p *parser) kill(it *patItem) {
	for i := it.e0; i < it.e1; i++ {
		p.edits[i].dead = true
	}
	it.e0, it.e1 = 0, 0
}

// drop: the group was an arrow function's parameter list — its identifiers
// are declarations.
func (p *parser) drop(s *patScope) {
	for i := range s.items {
		p.kill(&s.items[i])
	}
	s.items = s.items[:0]
}

// convert: the literal was a destructuring target — its identifiers are
// assigned, not read (R2 for location).
func (p *parser) convert(s *patScope) {
	for i := range s.items {
		it := &s.items[i]
		if it.target {
			continue
		}
		p.kill(it)
		it.target = true
		if it.name == idLocation && p.o.WrapSetLocation {
			it.e0 = len(p.edits)
			if it.shorthand {
				p.replace(it.start, it.end-it.start, "location:"+setLocation)
			} else {
				p.replace(it.start, it.end-it.start, setLocation)
			}
			it.e1 = len(p.edits)
		}
	}
}

func (p *parser) adopt(s *patScope) {
	if p.scope != nil && s != nil {
		p.scope.items = append(p.scope.items, s.items...)
	}
}

// ── program and statements ─────────────────────────────────────────────

func (p *parser) program() {
	p.next()
	for p.tok.kind != tEOF {
		p.statement()
	}
}

func (p *parser) block() {
	p.expect("{")
	for !p.is("}") {
		if p.tok.kind == tEOF {
			p.failAt()
		}
		p.statement()
	}
	p.next()
}

func (p *parser) statement() {
	p.enter()
	defer func() { p.nest-- }()
	if p.tok.kind == tPunct {
		switch {
		case p.is("{"):
			p.block()
			return
		case p.is(";"):
			p.next()
			return
		case p.is("@"): // decorators before a class
			p.decorators()
			p.statement()
			return
		}
	}
	if p.tok.kind == tIdent {
		switch string(p.text()) {
		case "var", "const":
			p.next()
			p.declarators()
			p.semicolon()
			return
		case "let":
			if t := p.peek(); t.kind == tIdent || t.kind == tPunct && (p.src[t.start] == '[' || p.src[t.start] == '{') {
				p.next()
				p.declarators()
				p.semicolon()
				return
			}
		case "function":
			p.next()
			p.function(false)
			return
		case "async":
			if t := p.peek(); !t.nl && t.kind == tIdent && string(p.src[t.start:t.end]) == "function" {
				p.next()
				p.next()
				p.function(true)
				return
			}
		case "class":
			p.next()
			p.class()
			return
		case "if":
			p.next()
			p.parenExpr()
			p.statement()
			if p.eatWord("else") {
				p.statement()
			}
			return
		case "for":
			p.forStatement()
			return
		case "while":
			p.next()
			p.parenExpr()
			p.statement()
			return
		case "do":
			p.next()
			p.statement()
			if !p.eatWord("while") {
				p.failAt()
			}
			p.parenExpr()
			p.semicolon()
			return
		case "return", "throw":
			p.next()
			if !p.tok.nl && !p.is(";") && !p.is("}") && p.tok.kind != tEOF {
				p.expression()
			}
			p.semicolon()
			return
		case "break", "continue":
			p.next()
			if p.tok.kind == tIdent && !p.tok.nl {
				p.next() // a label
			}
			p.semicolon()
			return
		case "try":
			p.next()
			p.block()
			if p.eatWord("catch") {
				if p.eat("(") {
					p.bindingTarget()
					p.expect(")")
				}
				p.block()
			}
			if p.eatWord("finally") {
				p.block()
			}
			return
		case "switch":
			p.next()
			p.parenExpr()
			p.expect("{")
			for !p.is("}") {
				switch {
				case p.eatWord("case"):
					p.expression()
					p.expect(":")
				case p.eatWord("default"):
					p.expect(":")
				case p.tok.kind == tEOF:
					p.failAt()
				default:
					p.statement()
				}
			}
			p.next()
			return
		case "with":
			p.next()
			p.parenExpr()
			p.withDepth++ // R13
			p.statement()
			p.withDepth--
			return
		case "debugger":
			// R12: an empty statement in its place (with its semicolon, so
			// that `if (a) debugger; else b` stays one statement).
			start := p.tok.start
			p.next()
			p.semicolon()
			if p.o.StripDebugger {
				p.replace(start, p.prevEnd-start, ";")
			}
			return
		case "import":
			if t := p.peek(); !(t.kind == tPunct && (p.src[t.start] == '(' || p.src[t.start] == '.')) {
				p.importDeclaration()
				return
			}
		case "export":
			p.exportDeclaration()
			return
		}
		// label: statement
		if p.peekIs(":") {
			p.next()
			p.next()
			p.statement()
			return
		}
	}
	p.expression()
	p.semicolon()
}

// parenExpr: ( expression ).
func (p *parser) parenExpr() {
	p.expect("(")
	noIn, forInit := p.noIn, p.forInit
	p.noIn, p.forInit = false, false
	p.expression()
	p.noIn, p.forInit = noIn, forInit
	p.expect(")")
}

func (p *parser) declarators() {
	for {
		p.bindingTarget()
		if p.eat("=") {
			p.assign(false)
		}
		if !p.eat(",") {
			return
		}
	}
}

func (p *parser) forStatement() {
	p.next() // for
	p.eatWord("await")
	p.expect("(")
	noIn, forInit := p.noIn, p.forInit
	p.noIn, p.forInit = true, false
	isDecl := false
	if !p.is(";") {
		if p.word("var") || p.word("const") {
			isDecl = true
		} else if p.word("let") {
			t := p.peek()
			// `for (let of = 0; …)` declares a variable named `of` (the
			// grammar forbids `for (let of …)` as a for-of over `let`);
			// `for (let in o)` iterates into the identifier `let`.
			isDecl = t.kind == tIdent && string(p.src[t.start:t.end]) != "in" ||
				t.kind == tPunct && (p.src[t.start] == '[' || p.src[t.start] == '{')
		} else if p.word("using") || p.word("await") {
			// `using x` / `await using x`: declarations when a name follows on the same line.
			t := p.peek()
			isDecl = p.word("using") && t.kind == tIdent && !t.nl && string(p.src[t.start:t.end]) != "of" && string(p.src[t.start:t.end]) != "in"
		}
		if isDecl {
			p.next()
			p.declarators()
		} else {
			p.forInit = true
			e := p.expression()
			p.forInit = false
			if p.word("in") || p.word("of") {
				// The head was a target (R2 for a bare location).
				switch {
				case e.lone == idLocation && p.o.WrapSetLocation:
					p.replace(e.start, e.end-e.start, setLocation)
				case e.pat != nil:
					p.convert(e.pat)
				}
			}
		}
	}
	p.noIn, p.forInit = false, false
	if p.word("of") {
		p.next()
		p.assign(false)
	} else if p.word("in") {
		p.next()
		p.expression()
	} else {
		p.expect(";")
		if !p.is(";") {
			p.expression()
		}
		p.expect(";")
		if !p.is(")") {
			p.expression()
		}
	}
	p.expect(")")
	p.noIn, p.forInit = noIn, forInit
	p.statement()
}

// skipBraces passes over a balanced { … } of names (import/export clauses,
// import attributes).
func (p *parser) skipBraces() {
	p.expect("{")
	for !p.is("}") {
		if p.tok.kind == tEOF {
			p.failAt()
		}
		p.next()
	}
	p.next()
}

func (p *parser) importAttributes() {
	if (p.word("with") || p.word("assert") && !p.tok.nl) && p.peekIs("{") {
		p.next()
		p.skipBraces()
	}
}

// source: the module specifier of an import/export declaration (R8).
func (p *parser) source() {
	if p.tok.kind != tStr {
		p.failAt()
	}
	if p.o.WrapStaticImport {
		p.specifier(p.tok.start, p.tok.end)
	}
	p.next()
	p.importAttributes()
	p.semicolon()
}

func (p *parser) importDeclaration() {
	p.next() // import
	for p.tok.kind != tStr {
		switch {
		case p.tok.kind == tEOF:
			p.failAt()
		case p.is("{"):
			p.skipBraces()
		default:
			p.next() // a name, `*`, `as`, `,`, `from`
		}
	}
	p.source()
}

func (p *parser) exportDeclaration() {
	p.next() // export
	switch {
	case p.eatWord("default"):
		switch {
		case p.word("function"):
			p.next()
			p.function(false)
		case p.word("async") && func() bool { t := p.peek(); return !t.nl && string(p.src[t.start:t.end]) == "function" }():
			p.next()
			p.next()
			p.function(true)
		case p.word("class"):
			p.next()
			p.class()
		default:
			p.assign(false)
			p.semicolon()
		}
	case p.is("*"):
		p.next()
		if p.eatWord("as") {
			p.next() // the name (an identifier or a string)
		}
		if !p.eatWord("from") {
			p.failAt()
		}
		p.source()
	case p.is("{"):
		p.skipBraces()
		if p.eatWord("from") {
			p.source()
		} else {
			p.semicolon()
		}
	default:
		p.statement()
	}
}

// ── bindings ───────────────────────────────────────────────────────────

// bindingTarget: an identifier, [pattern] or {pattern} being declared.
func (p *parser) bindingTarget() {
	switch {
	case p.tok.kind == tIdent:
		p.next()
	case p.is("["):
		p.next()
		for !p.is("]") {
			if p.eat(",") {
				continue
			}
			p.eat("...")
			p.bindingTarget()
			if p.eat("=") {
				p.assignPlain()
			}
			if !p.is("]") {
				p.expect(",")
			}
		}
		p.next()
	case p.is("{"):
		p.next()
		for !p.is("}") {
			if p.eat("...") {
				p.bindingTarget()
			} else {
				shorthand := p.tok.kind == tIdent
				p.propertyName()
				if p.eat(":") {
					p.bindingTarget()
				} else if !shorthand {
					p.failAt()
				}
				if p.eat("=") {
					p.assignPlain()
				}
			}
			if !p.is("}") {
				p.expect(",")
			}
		}
		p.next()
	default:
		p.failAt()
	}
}

// assignPlain: an assignment expression inside brackets (`in` is an operator).
func (p *parser) assignPlain() {
	noIn, forInit := p.noIn, p.forInit
	p.noIn, p.forInit = false, false
	p.assign(false)
	p.noIn, p.forInit = noIn, forInit
}

// propertyName: a property key. Reports whether it is a plain identifier
// (which could be a shorthand) and its extent.
func (p *parser) propertyName() {
	switch {
	case p.tok.kind == tIdent || p.tok.kind == tStr || p.tok.kind == tNum || p.tok.kind == tPrivate:
		p.next()
	case p.is("["):
		p.next()
		p.assignPlain()
		p.expect("]")
	default:
		p.failAt()
	}
}

// ── functions and classes ──────────────────────────────────────────────

// function: after `function` — [*] [name] (params) { body }.
func (p *parser) function(async bool) {
	generator := p.eat("*")
	if p.tok.kind == tIdent {
		p.next()
	}
	p.params()
	p.functionBody(fnState{async: async, generator: generator})
}

func (p *parser) params() {
	p.expect("(")
	for !p.is(")") {
		p.eat("...")
		p.bindingTarget()
		if p.eat("=") {
			p.assignPlain()
		}
		if !p.is(")") {
			p.expect(",")
		}
	}
	p.next()
}

func (p *parser) functionBody(st fnState) {
	fn, noIn, forInit, scope := p.fn, p.noIn, p.forInit, p.scope
	p.fn, p.noIn, p.forInit, p.scope = st, false, false, nil
	p.depth++
	p.block()
	p.depth--
	p.fn, p.noIn, p.forInit, p.scope = fn, noIn, forInit, scope
}

func (p *parser) arrowBody(async bool) {
	if p.is("{") {
		p.functionBody(fnState{async: async})
		return
	}
	fn, scope := p.fn, p.scope
	p.fn, p.scope = fnState{async: async}, nil
	p.depth++
	p.assign(false)
	p.depth--
	p.fn, p.scope = fn, scope
}

func (p *parser) decorators() {
	for p.eat("@") {
		e := p.lhs(true)
		p.read(&e)
	}
}

// nameStart: the current token can begin a property name.
func (p *parser) nameStart(t token) bool {
	return t.kind == tIdent || t.kind == tStr || t.kind == tNum || t.kind == tPrivate ||
		t.kind == tPunct && (p.src[t.start] == '[' || p.src[t.start] == '*' && t.end-t.start == 1)
}

// class: after `class` — [name] [extends heritage] { members }.
func (p *parser) class() {
	if p.tok.kind == tIdent && !p.word("extends") {
		p.next()
	}
	if p.eatWord("extends") {
		e := p.lhs(true)
		p.read(&e)
	}
	p.expect("{")
	for !p.is("}") {
		switch {
		case p.tok.kind == tEOF:
			p.failAt()
		case p.eat(";"):
			continue
		case p.is("@"):
			p.decorators()
			continue
		}
		if p.word("static") {
			t := p.peek()
			if t.kind == tPunct && p.src[t.start] == '{' {
				p.next()
				p.functionBody(fnState{})
				continue
			}
			if p.nameStart(t) {
				p.next()
			}
		}
		p.memberTail(false)
	}
	p.next()
}

// memberTail parses one method, accessor or field (of a class, or — with
// object true — the method forms of an object literal, where it reports
// false if what follows is not a method).
func (p *parser) memberTail(object bool) bool {
	async, generator := false, false
	for {
		if p.tok.kind == tIdent {
			w := string(p.text())
			if w == "async" || w == "get" || w == "set" || w == "accessor" && !object {
				t := p.peek()
				if p.nameStart(t) && (w != "async" && w != "accessor" || !t.nl) {
					async = async || w == "async"
					p.next()
					continue
				}
			}
		}
		break
	}
	if p.eat("*") {
		generator = true
	}
	p.propertyName()
	if p.is("(") {
		p.params()
		p.functionBody(fnState{async: async, generator: generator})
		return true
	}
	if object {
		return false
	}
	if p.eat("=") { // a field's initializer
		fn, scope := p.fn, p.scope
		p.fn, p.scope = fnState{}, nil
		p.depth++
		p.assignPlain()
		p.depth--
		p.fn, p.scope = fn, scope
	}
	p.semicolon()
	return true
}

// ── expressions ────────────────────────────────────────────────────────

// expression: assignment expressions separated by commas.
func (p *parser) expression() expr {
	e := p.assign(false)
	if !p.is(",") {
		return e
	}
	for p.eat(",") {
		last := p.assign(false)
		e = expr{start: e.start, end: last.end}
	}
	return e
}

func (p *parser) isAssignOp() bool {
	if p.tok.kind != tPunct {
		return false
	}
	t := p.text()
	if t[len(t)-1] != '=' || len(t) == 1 {
		return false
	}
	switch string(t) {
	case "==", "===", "!=", "!==", "<=", ">=", "=>":
		return false
	}
	return true
}

// startsExpression: the current token can begin an expression (for yield).
func (p *parser) startsExpression() bool {
	switch p.tok.kind {
	case tEOF:
		return false
	case tPunct:
		switch p.src[p.tok.start] {
		case ')', ']', '}', ',', ';', ':', '?', '=', '|', '&', '^', '%', '>', '.':
			return false
		}
	}
	return !p.word("in") && !p.word("of")
}

// assign parses an assignment expression. With patPos, it stands where a
// binding or assignment target would stand if the enclosing (…), […] or
// {…} turns out to be a pattern. What it returns has been read, except in
// a for head before `in` / `of`.
func (p *parser) assign(patPos bool) expr {
	p.enter()
	defer func() { p.nest-- }()
	if p.fn.generator && p.word("yield") {
		start := p.tok.start
		p.next()
		if !p.tok.nl {
			p.eat("*")
			if p.startsExpression() {
				p.assign(false)
			}
		}
		return expr{start: start, end: p.prevEnd}
	}
	left := p.conditional()
	switch {
	case p.is("=>") && !p.tok.nl && (left.lone != idNone || left.pat != nil && left.paren):
		if left.pat != nil {
			p.drop(left.pat) // its identifiers are parameters
		}
		p.next()
		p.arrowBody(false)
		return expr{start: left.start, end: p.prevEnd}

	case p.is("="):
		if left.lone != idNone {
			if left.lone == idLocation && p.o.WrapSetLocation { // R2
				e0 := len(p.edits)
				p.replace(left.start, left.end-left.start, setLocation)
				if patPos && p.scope != nil {
					p.scope.items = append(p.scope.items, patItem{e0: e0, e1: len(p.edits), start: left.start, end: left.end, name: idLocation, target: true})
				}
			}
		} else if left.pat != nil {
			p.convert(left.pat)
			if patPos {
				p.adopt(left.pat)
			}
		}
		p.next()
		p.assign(false)
		return expr{start: left.start, end: p.prevEnd}

	case p.isAssignOp(): // compound: the target is left as written
		p.next()
		p.assign(false)
		return expr{start: left.start, end: p.prevEnd}
	}
	if p.forInit && (p.word("in") || p.word("of")) {
		return left // a for-in / for-of target: the statement decides
	}
	if left.lone != idNone {
		e0 := len(p.edits)
		id, start, end := left.lone, left.start, left.end
		p.read(&left)
		if patPos && p.scope != nil && len(p.edits) > e0 {
			p.scope.items = append(p.scope.items, patItem{e0: e0, e1: len(p.edits), start: start, end: end, name: id})
		}
	} else if left.pat != nil && patPos {
		p.adopt(left.pat)
	}
	return left
}

func (p *parser) conditional() expr {
	test := p.binary(0)
	if !p.is("?") {
		return test
	}
	p.read(&test)
	p.next()
	noIn, forInit := p.noIn, p.forInit
	p.noIn, p.forInit = false, false
	p.assign(false)
	p.noIn, p.forInit = noIn, forInit
	p.expect(":")
	forInit = p.forInit
	p.forInit = false
	p.assign(false)
	p.forInit = forInit
	return expr{start: test.start, end: p.prevEnd}
}

// binaryPrec is the precedence of the binary operator at the current
// token, 0 if there is none.
func (p *parser) binaryPrec() int {
	if p.tok.kind == tIdent {
		if p.word("instanceof") || p.word("in") && !p.noIn {
			return 8
		}
		return 0
	}
	if p.tok.kind != tPunct {
		return 0
	}
	switch string(p.text()) {
	case "??":
		return 1
	case "||":
		return 2
	case "&&":
		return 3
	case "|":
		return 4
	case "^":
		return 5
	case "&":
		return 6
	case "==", "!=", "===", "!==":
		return 7
	case "<", ">", "<=", ">=":
		return 8
	case "<<", ">>", ">>>":
		return 9
	case "+", "-":
		return 10
	case "*", "/", "%":
		return 11
	case "**":
		return 12
	}
	return 0
}

func (p *parser) binary(min int) expr {
	left := p.unary()
	for {
		prec := p.binaryPrec()
		if prec == 0 || prec <= min {
			return left
		}
		p.read(&left)
		p.next()
		next := prec
		if prec == 12 {
			next = prec - 1 // ** associates to the right
		}
		right := p.binary(next)
		p.read(&right)
		left = expr{start: left.start, end: right.end}
	}
}

func (p *parser) unary() expr {
	start := p.tok.start
	if p.tok.kind == tPunct {
		switch string(p.text()) {
		case "!", "~", "+", "-":
			p.next()
			e := p.unaryOperand()
			p.read(&e)
			return expr{start: start, end: e.end}
		case "++", "--":
			p.next()
			e := p.unaryOperand() // a target: left as written
			return expr{start: start, end: e.end}
		}
	} else if p.tok.kind == tIdent {
		switch string(p.text()) {
		case "typeof", "delete":
			p.next()
			e := p.unaryOperand() // not a read of a bare identifier
			return expr{start: start, end: e.end}
		case "void":
			p.next()
			e := p.unaryOperand()
			p.read(&e)
			return expr{start: start, end: e.end}
		case "await":
			if p.fn.async || p.depth == 0 {
				p.next()
				e := p.unaryOperand()
				p.read(&e)
				return expr{start: start, end: e.end}
			}
		}
	}
	e := p.lhs(true)
	if (p.is("++") || p.is("--")) && !p.tok.nl {
		p.next() // a target: left as written
		return expr{start: e.start, end: p.prevEnd}
	}
	return e
}

func (p *parser) unaryOperand() expr {
	p.enter()
	e := p.unary()
	p.nest--
	return e
}

// lhs parses a member / call chain: a primary expression and its suffixes
// (calls only with `calls`: not in the callee of `new`).
func (p *parser) lhs(calls bool) expr {
	var e expr
	if p.word("new") {
		e = p.newExpression()
	} else {
		e = p.primary()
	}
	for {
		switch {
		case p.is(".") || p.is("?."):
			optional := p.is("?.")
			if optional && !calls {
				return e
			}
			opPos := p.tok.start
			if !e.super && !e.meta {
				p.read(&e)
			}
			p.next()
			if optional && p.is("(") {
				e = p.call(e, true)
				continue
			}
			if optional && p.is("[") {
				e = p.index(e, true, calls)
				continue
			}
			if p.tok.kind != tIdent && p.tok.kind != tPrivate {
				p.failAt()
			}
			name := "#"
			if p.tok.kind == tIdent {
				name = identName(p.text())
			}
			nameEnd := p.tok.end
			p.next()
			if e.meta && name == "url" && p.o.WrapImportMetaUrl && p.o.BaseURL != nil { // R9
				p.replace(e.start, nameEnd-e.start, jsonString(p.o.BaseURL.String()))
				e = expr{start: e.start, end: nameEnd}
				continue
			}
			applied := p.member(&e, name, true, false, optional, opPos, 0, 0, calls && p.calledNext())
			e = expr{start: e.start, end: nameEnd, chain: e.chain || optional, wrapped: e.wrapped || applied}

		case p.is("["):
			if !e.super {
				p.read(&e)
			}
			e = p.index(e, false, calls)

		case p.is("(") && calls:
			e = p.call(e, false)

		case p.tok.kind == tTemplate || p.tok.kind == tTemplateHead:
			p.read(&e)
			p.template()
			e = expr{start: e.start, end: p.prevEnd, chain: e.chain, wrapped: e.wrapped}

		default:
			return e
		}
	}
}

// calledNext: the member just parsed is being called.
func (p *parser) calledNext() bool {
	return p.is("(") || p.is("?.") && p.peekIs("(")
}

// index parses [key] after obj (the `[` is current) and applies the member
// rules.
func (p *parser) index(obj expr, optional, calls bool) expr {
	lb := p.tok.start
	p.next()
	noIn, forInit := p.noIn, p.forInit
	p.noIn, p.forInit = false, false
	key := p.expression()
	p.noIn, p.forInit = noIn, forInit
	rb := p.tok.start
	p.expect("]")
	end := p.prevEnd
	// A constant key is a name.
	name, static := "", false
	switch key.lit {
	case litString:
		if v, ok := stringValue(p.src[key.start:key.end]); ok {
			name, static = v, true
		} else {
			name, static = "#", true
		}
	case litTemplate:
		if v, ok := templateValue(p.src[key.start:key.end]); ok {
			name, static = v, true
		} else {
			name, static = "#", true
		}
	case litOther:
		name, static = "#", true
	}
	applied := p.member(&obj, name, static, true, optional, 0, lb, rb, calls && p.calledNext())
	return expr{start: obj.start, end: end, chain: obj.chain || optional, wrapped: obj.wrapped || applied}
}

// call parses (arguments) after callee (the `(` is current).
func (p *parser) call(callee expr, optional bool) expr {
	// async (…) => … looks like a call until the arrow.
	asyncArrow := callee.lone == idAsync && !optional && !p.tok.nl
	directEval := callee.lone == idEval && !optional && p.o.WrapEvalArg
	if directEval {
		// R6 needs a first argument that is not a spread.
		t := p.peek()
		if t.kind == tPunct && (p.src[t.start] == ')' || t.end-t.start == 3 && p.src[t.start] == '.') {
			directEval = false
		}
	}
	if !directEval && !callee.super {
		p.read(&callee)
	}
	p.next() // (
	noIn, forInit, outer := p.noIn, p.forInit, p.scope
	p.noIn, p.forInit = false, false
	var scope *patScope
	if asyncArrow {
		scope = &patScope{}
		p.scope = scope
	}
	first := true
	for !p.is(")") {
		if p.tok.kind == tEOF {
			p.failAt()
		}
		spread := p.eat("...")
		if first && directEval && !spread { // R6
			a := p.assign(false)
			p.open(a.start, "$rewriter.wrap_eval_arg(eval,")
			p.close(a.end, ")")
		} else {
			p.assign(asyncArrow)
		}
		first = false
		if !p.is(")") {
			p.expect(",")
		}
	}
	p.next()
	p.noIn, p.forInit, p.scope = noIn, forInit, outer
	if asyncArrow && p.is("=>") && !p.tok.nl {
		p.drop(scope)
		p.next()
		p.arrowBody(true)
		return expr{start: callee.start, end: p.prevEnd}
	}
	return expr{start: callee.start, end: p.prevEnd, chain: callee.chain || optional}
}

// newExpression: `new` is current.
func (p *parser) newExpression() expr {
	start := p.tok.start
	p.next()
	if p.is(".") { // new.target
		p.next()
		p.next()
		return expr{start: start, end: p.prevEnd}
	}
	callee := p.lhs(false)
	worker := callee.lone == idWorker || callee.lone == idSharedWorker
	p.read(&callee)
	if callee.wrapped { // R11
		p.open(callee.start, "(")
		p.close(callee.end, ")")
	}
	if p.is("(") {
		p.next()
		noIn, forInit := p.noIn, p.forInit
		p.noIn, p.forInit = false, false
		first := true
		for !p.is(")") {
			if p.tok.kind == tEOF {
				p.failAt()
			}
			spread := p.eat("...")
			a := p.assign(false)
			if first && worker && !spread && p.o.WrapNewWorker { // R10
				p.open(a.start, "$rewriter.wrap_worker_url(")
				p.close(a.end, ")")
			}
			first = false
			if !p.is(")") {
				p.expect(",")
			}
		}
		p.next()
		p.noIn, p.forInit = noIn, forInit
	}
	return expr{start: start, end: p.prevEnd}
}

// template parses a template literal (its first token is current).
func (p *parser) template() {
	if p.tok.kind == tTemplate {
		p.next()
		return
	}
	noIn, forInit := p.noIn, p.forInit
	p.noIn, p.forInit = false, false
	for {
		p.next() // past the head or a middle
		p.expression()
		if !p.is("}") {
			p.failAt()
		}
		p.templateContinue()
		if p.tok.kind == tTemplateTail {
			break
		}
	}
	p.noIn, p.forInit = noIn, forInit
	p.next()
}

func (p *parser) primary() expr {
	start := p.tok.start
	switch p.tok.kind {
	case tIdent:
		w := string(p.text())
		switch w {
		case "function":
			p.next()
			p.function(false)
			return expr{start: start, end: p.prevEnd}
		case "class":
			p.next()
			p.class()
			return expr{start: start, end: p.prevEnd}
		case "this":
			p.next()
			return expr{start: start, end: p.prevEnd}
		case "super":
			p.next()
			return expr{start: start, end: p.prevEnd, super: true}
		case "null", "true", "false":
			p.next()
			return expr{start: start, end: p.prevEnd, lit: litOther}
		case "import":
			p.next()
			if p.is(".") { // import.meta
				p.next()
				p.next()
				return expr{start: start, end: p.prevEnd, meta: true}
			}
			return p.importCall(start)
		case "async":
			t := p.peek()
			if !t.nl && t.kind == tIdent {
				if string(p.src[t.start:t.end]) == "function" {
					p.next()
					p.next()
					p.function(true)
					return expr{start: start, end: p.prevEnd}
				}
				// async x => …
				save := p.lexer
				p.next()
				p.next()
				if p.is("=>") && !p.tok.nl {
					p.next()
					p.arrowBody(true)
					return expr{start: start, end: p.prevEnd}
				}
				p.lexer = save
			}
		}
		end := p.tok.end
		id := identCode(identName(p.text()))
		p.next()
		return expr{start: start, end: end, lone: id}

	case tPrivate: // #x in obj
		p.next()
		return expr{start: start, end: p.prevEnd}

	case tNum:
		p.next()
		return expr{start: start, end: p.prevEnd, lit: litOther}

	case tStr:
		p.next()
		return expr{start: start, end: p.prevEnd, lit: litString}

	case tTemplate:
		p.next()
		return expr{start: start, end: p.prevEnd, lit: litTemplate}

	case tTemplateHead:
		p.template()
		return expr{start: start, end: p.prevEnd}

	case tPunct:
		switch p.src[start] {
		case '/':
			p.regex()
			p.next()
			return expr{start: start, end: p.prevEnd, lit: litOther}
		case '(':
			return p.group()
		case '[':
			return p.arrayLiteral()
		case '{':
			return p.objectLiteral()
		case '@':
			p.decorators()
			if !p.eatWord("class") {
				p.failAt()
			}
			p.class()
			return expr{start: start, end: p.prevEnd}
		}
	}
	p.failAt()
	return expr{}
}

// importCall: import(source[, options]) — `import` consumed (R7).
func (p *parser) importCall(start int) expr {
	p.expect("(")
	noIn, forInit := p.noIn, p.forInit
	p.noIn, p.forInit = false, false
	// A literal specifier that can be proxified now is replaced; anything
	// else goes through the helper at run time.
	literal := p.tok.kind == tStr
	litStart, litEnd := p.tok.start, p.tok.end
	s := p.assign(false)
	literal = literal && s.start == litStart && s.end == litEnd
	bare := false // a literal bare specifier ("react") is the import map's: left as written
	if literal {
		if v, ok := stringValue(p.src[litStart:litEnd]); ok && !urlrewrite.IsURLLikeSpecifier(v) {
			bare = true
		}
	}
	if !bare && !(literal && p.o.WrapStaticImport && p.specifier(litStart, litEnd)) && p.o.WrapImportArg {
		p.open(s.start, "$rewriter.wrap_import_arg(")
		if p.o.BaseURL != nil {
			p.close(s.end, ","+jsonString(p.o.BaseURL.String())+")")
		} else {
			p.close(s.end, ")")
		}
	}
	if p.eat(",") && !p.is(")") {
		p.assign(false)
		p.eat(",")
	}
	p.noIn, p.forInit = noIn, forInit
	p.expect(")")
	return expr{start: start, end: p.prevEnd}
}

// group: ( … ) — a parenthesized expression, or an arrow function's
// parameters.
func (p *parser) group() expr {
	start := p.tok.start
	p.next()
	noIn, forInit, outer := p.noIn, p.forInit, p.scope
	p.noIn, p.forInit = false, false
	scope := &patScope{}
	p.scope = scope
	for !p.is(")") {
		if p.tok.kind == tEOF {
			p.failAt()
		}
		p.eat("...")
		p.assign(true)
		if !p.is(")") {
			p.expect(",")
		}
	}
	p.next()
	p.noIn, p.forInit, p.scope = noIn, forInit, outer
	return expr{start: start, end: p.prevEnd, pat: scope, paren: true}
}

func (p *parser) arrayLiteral() expr {
	start := p.tok.start
	p.next()
	noIn, forInit, outer := p.noIn, p.forInit, p.scope
	p.noIn, p.forInit = false, false
	scope := &patScope{}
	p.scope = scope
	for !p.is("]") {
		if p.tok.kind == tEOF {
			p.failAt()
		}
		if p.eat(",") {
			continue
		}
		p.eat("...")
		p.assign(true)
		if !p.is("]") {
			p.expect(",")
		}
	}
	p.next()
	p.noIn, p.forInit, p.scope = noIn, forInit, outer
	return expr{start: start, end: p.prevEnd, pat: scope}
}

func (p *parser) objectLiteral() expr {
	start := p.tok.start
	p.next()
	noIn, forInit, outer := p.noIn, p.forInit, p.scope
	p.noIn, p.forInit = false, false
	scope := &patScope{}
	p.scope = scope
	for !p.is("}") {
		if p.tok.kind == tEOF {
			p.failAt()
		}
		if p.eat("...") {
			p.assign(true)
		} else {
			p.property()
		}
		if !p.is("}") {
			p.expect(",")
		}
	}
	p.next()
	p.noIn, p.forInit, p.scope = noIn, forInit, outer
	return expr{start: start, end: p.prevEnd, pat: scope}
}

// property: one member of an object literal.
func (p *parser) property() {
	// name: value, a shorthand, or a method?
	if p.tok.kind == tIdent {
		t := p.peek()
		if t.kind == tPunct {
			c := p.src[t.start]
			simple := t.end-t.start == 1
			switch {
			case c == ':' && simple:
				p.next()
				p.next()
				p.assign(true)
				return
			case (c == ',' || c == '}') && simple: // {id}
				id, s, e := identCode(identName(p.text())), p.tok.start, p.tok.end
				p.next()
				if h := p.identHelper(id); h != "" {
					e0 := len(p.edits)
					p.open(s, identName(p.src[s:e])+":$rewriter."+h+"(")
					p.close(e, ")")
					p.scope.items = append(p.scope.items, patItem{e0: e0, e1: len(p.edits), start: s, end: e, name: id, shorthand: true})
				} else if id == idLocation {
					p.scope.items = append(p.scope.items, patItem{start: s, end: e, name: id, shorthand: true})
				}
				return
			case c == '=' && simple: // {id = default}: only in a pattern
				id, s, e := identCode(identName(p.text())), p.tok.start, p.tok.end
				p.next()
				p.next()
				if id == idLocation {
					p.scope.items = append(p.scope.items, patItem{start: s, end: e, name: id, shorthand: true})
				}
				scope := p.scope
				p.assign(false)
				p.scope = scope
				return
			}
		}
	}
	if p.memberTail(true) {
		return
	}
	p.expect(":")
	p.assign(true)
}

// ── literal values ─────────────────────────────────────────────────────

// stringValue is the value of a string literal (with its quotes).
func stringValue(raw []byte) (string, bool) {
	if len(raw) < 2 {
		return "", false
	}
	return cooked(raw[1 : len(raw)-1])
}

// templateValue is the cooked value of a template with no substitution.
func templateValue(raw []byte) (string, bool) {
	if len(raw) < 2 {
		return "", false
	}
	body := raw[1 : len(raw)-1]
	if bytes.IndexByte(body, '\r') >= 0 { // CR LF and CR cook to LF
		body = bytes.ReplaceAll(bytes.ReplaceAll(body, []byte("\r\n"), []byte("\n")), []byte("\r"), []byte("\n"))
	}
	return cooked(body)
}

// cooked decodes the escapes of string or template characters.
func cooked(s []byte) (string, bool) {
	if bytes.IndexByte(s, '\\') < 0 {
		return string(s), true
	}
	var b strings.Builder
	for i := 0; i < len(s); {
		c := s[i]
		if c != '\\' {
			b.WriteByte(c)
			i++
			continue
		}
		i++
		if i >= len(s) {
			return "", false
		}
		c = s[i]
		i++
		switch c {
		case 'n':
			b.WriteByte('\n')
		case 't':
			b.WriteByte('\t')
		case 'r':
			b.WriteByte('\r')
		case 'b':
			b.WriteByte('\b')
		case 'f':
			b.WriteByte('\f')
		case 'v':
			b.WriteByte('\v')
		case '\r':
			if i < len(s) && s[i] == '\n' {
				i++
			}
		case '\n':
		case 'x':
			if i+2 > len(s) {
				return "", false
			}
			v, err := strconv.ParseUint(string(s[i:i+2]), 16, 8)
			if err != nil {
				return "", false
			}
			b.WriteRune(rune(v))
			i += 2
		case 'u':
			r, n := unicodeEscape(s[i:])
			if r == utf8.RuneError {
				return "", false
			}
			i += n
			// a surrogate pair written as two escapes
			if r >= 0xd800 && r < 0xdc00 && i+1 < len(s) && s[i] == '\\' && s[i+1] == 'u' {
				if lo, m := unicodeEscape(s[i+2:]); lo >= 0xdc00 && lo < 0xe000 {
					r = 0x10000 + (r-0xd800)<<10 + (lo - 0xdc00)
					i += 2 + m
				}
			}
			b.WriteRune(r)
		default:
			if c >= '0' && c <= '7' { // legacy octal
				v := int(c - '0')
				for k := 0; k < 2 && i < len(s) && s[i] >= '0' && s[i] <= '7' && v*8+int(s[i]-'0') <= 255; k++ {
					v = v*8 + int(s[i]-'0')
					i++
				}
				b.WriteRune(rune(v))
				continue
			}
			if c == 0xe2 && i+1 < len(s) && s[i] == 0x80 && (s[i+1] == 0xa8 || s[i+1] == 0xa9) {
				i += 2 // a line continuation at U+2028 / U+2029
				continue
			}
			b.WriteByte(c)
		}
	}
	return b.String(), true
}

// jsonString is JSON.stringify(s): the string literal the TS reference
// writes (encoding/json would also escape <, > and &).
func jsonString(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 2)
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			if r < 0x20 {
				b.WriteString(`\u00`)
				b.WriteByte("0123456789abcdef"[r>>4])
				b.WriteByte("0123456789abcdef"[r&15])
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}
