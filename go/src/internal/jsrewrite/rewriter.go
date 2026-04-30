// Package jsrewrite is the JavaScript AST rewriter — it injects the
// $rewriter.wrap_* runtime calls around URL-bearing accessors that the
// browser executes at runtime, the things the HTML rewriter can't catch
// statically.
//
// Built on github.com/tdewolff/parse/v2/js — fast lexer+parser+AST,
// chosen for parse throughput (~50MB/s vs ~5MB/s for goja's parser, ~10×
// for esprima). The AST nodes are tdewolff types; we walk them with a
// custom recursive visitor and mutate in place.
//
// Rules implemented (one per server-injected runtime helper on the
// client's $rewriter object):
//
//   - WRAP_GET_LOCATION       — `location`        (rvalue)
//   - WRAP_SET_LOCATION       — `location = X`   (lvalue)
//   - WRAP_LOCATION           — `obj.location`
//   - WRAP_GET_TOP_WINDOW     — `top`            (rvalue)
//   - WRAP_TOP_WINDOW         — `obj.top`
//   - WRAP_GET_PARENT_WINDOW  — `parent`         (rvalue)
//   - WRAP_PARENT_WINDOW      — `obj.parent`
//   - WRAP_DOCUMENT_WRITE     — `obj.write`/`obj.writeln`
//   - WRAP_POST_MESSAGE       — `obj.postMessage`
//   - WRAP_EVAL               — `eval` as rvalue (not call target)
//   - WRAP_EVAL_ARG           — `eval(arg, ...)` first arg
//   - WRAP_EVAL_MEMEXP        — `obj.eval`
//   - WRAP_MEMBER_EXPRESSION  — `obj[expr]` computed access
//
// alreadyRewritten() detects already-rewritten input (`$rewriter.wrap_` or
// `$rewriter_init(` substring) and short-circuits.
package jsrewrite

import (
	"bytes"
	"context"
	"log/slog"
	"net/url"
	"strings"

	"github.com/tdewolff/parse/v2"
	"github.com/tdewolff/parse/v2/js"
)

// Options toggle individual transformation rules. Defaults (zero value)
// disable everything; the caller picks the set they want.
type Options struct {
	WrapGetLocation      bool
	WrapSetLocation      bool
	WrapLocation         bool
	WrapGetTopWindow     bool
	WrapTopWindow        bool
	WrapGetParentWindow  bool
	WrapParentWindow     bool
	WrapDocumentWrite    bool
	WrapPostMessage      bool
	WrapEval             bool
	WrapEvalArg          bool
	WrapEvalMemexp       bool
	WrapMemberExpression bool
	WrapImportArg        bool

	// BaseURL is the URL of the script being rewritten. When set together
	// with ProxifyURL, string-literal import() specifiers are resolved
	// against this URL and proxified statically at rewrite time, bypassing
	// the client-side wrap_import_arg. Dynamic specifiers (non-literals)
	// still fall back to wrap_import_arg.
	BaseURL    *url.URL
	ProxifyURL func(rawURL string, base *url.URL) string

	// Logger receives parse-failure and template-graft diagnostic events
	// at debug level. nil disables logging — keeps the rewriter usable
	// from tests without plumbing a logger through every call site.
	Logger *slog.Logger
}

// DefaultOptions enables every rewrite rule.
func DefaultOptions() Options {
	return Options{
		WrapGetLocation:      true,
		WrapSetLocation:      true,
		WrapLocation:         true,
		WrapGetTopWindow:     true,
		WrapTopWindow:        true,
		WrapGetParentWindow:  true,
		WrapParentWindow:     true,
		WrapDocumentWrite:    true,
		WrapPostMessage:      true,
		WrapEval:             true,
		WrapEvalArg:          true,
		WrapEvalMemexp:       true,
		WrapMemberExpression: true,
		WrapImportArg:        true,
	}
}

// Rewrite parses src as JS, applies enabled rules, and returns the rewritten
// source. If parsing fails or the input is already-rewritten, returns src
// unchanged so the proxy never breaks pages it can't safely transform.
//
// Parse failures are logged at debug level (not warn) — minified bundles
// frequently use tdewolff-incompatible edge cases, and we don't want to
// flood logs every time we fall back to passthrough on a real-world page.
func Rewrite(src []byte, opts Options) []byte {
	if alreadyRewritten(src) {
		return src
	}
	ast, err := js.Parse(parse.NewInputBytes(src), js.Options{})
	if err != nil {
		if opts.Logger != nil {
			opts.Logger.LogAttrs(context.Background(), slog.LevelDebug, "js parse failed; passing through",
				slog.String("err", err.Error()),
				slog.Int("size", len(src)),
				slog.String("snippet", snippet(src, 120)),
			)
		}
		return src
	}
	r := &rewriter{opts: opts}
	r.walkBlockStmt(&ast.BlockStmt)

	var buf bytes.Buffer
	if r.usedCrnTmp {
		// Declare the bracket-key intermediate identifier the rewritten
		// output references. Without this declaration, strict-mode scripts
		// throw ReferenceError on `$__crn_tmp__ = expr` (assignment to
		// undeclared name). `var` at script top-level scope-leaks to the
		// global regardless of strict mode, which is what the
		// wrap_member_expression template needs (same identifier read on
		// the bracket-access side of the same expression).
		buf.WriteString("var $__crn_tmp__;\n")
	}
	ast.JS(&buf)
	return buf.Bytes()
}

// snippet returns up to n leading bytes of src as a string with newlines
// flattened — useful for log lines.
func snippet(src []byte, n int) string {
	if len(src) > n {
		src = src[:n]
	}
	s := string(src)
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", "")
	if len(src) == n {
		s += "…"
	}
	return s
}

// alreadyRewritten short-circuits on already-rewritten input. Cheap substring scan.
func alreadyRewritten(src []byte) bool {
	return bytes.Contains(src, []byte("$rewriter.wrap_")) ||
		bytes.Contains(src, []byte("$rewriter_init("))
}

// rewriter holds per-pass state.
type rewriter struct {
	opts Options
	// usedCrnTmp tracks whether wrapMemberExpression fired during this pass.
	// When it has, the output uses an intermediate identifier `$__crn_tmp__`
	// for the bracket-key expression — Rewrite() prepends a declaration so
	// strict-mode scripts don't ReferenceError on the implicit assignment.
	usedCrnTmp bool
}

// ── tree walk ────────────────────────────────────────────────────────────────
// tdewolff doesn't ship a generic visitor, so we type-switch our way through
// the AST. Coverage is the union of node shapes the rules need to inspect,
// not every shape the parser can emit — unhandled nodes pass through (their
// children, if any, are recursed via the next switch).

func (r *rewriter) walkBlockStmt(b *js.BlockStmt) {
	for i := range b.List {
		b.List[i] = r.walkStmt(b.List[i])
	}
}

func (r *rewriter) walkStmt(s js.IStmt) js.IStmt {
	switch n := s.(type) {
	case *js.ExprStmt:
		n.Value = r.rvalue(n.Value)
	case *js.VarDecl:
		for i := range n.List {
			r.walkBindingElement(&n.List[i])
		}
	case *js.IfStmt:
		n.Cond = r.rvalue(n.Cond)
		n.Body = r.walkStmt(n.Body)
		if n.Else != nil {
			n.Else = r.walkStmt(n.Else)
		}
	case *js.ForStmt:
		// Init is IExpr (VarDecl satisfies both IStmt & IExpr in tdewolff).
		if n.Init != nil {
			n.Init = r.rvalue(n.Init)
		}
		if n.Cond != nil {
			n.Cond = r.rvalue(n.Cond)
		}
		if n.Post != nil {
			n.Post = r.rvalue(n.Post)
		}
		r.walkBlockStmt(n.Body)
	case *js.ForInStmt:
		// Init is the iteration variable target (lvalue) — leave it alone for
		// now. Value side is rvalue.
		n.Value = r.rvalue(n.Value)
		r.walkBlockStmt(n.Body)
	case *js.ForOfStmt:
		n.Value = r.rvalue(n.Value)
		r.walkBlockStmt(n.Body)
	case *js.WhileStmt:
		n.Cond = r.rvalue(n.Cond)
		n.Body = r.walkStmt(n.Body)
	case *js.DoWhileStmt:
		n.Cond = r.rvalue(n.Cond)
		n.Body = r.walkStmt(n.Body)
	case *js.ReturnStmt:
		if n.Value != nil {
			n.Value = r.rvalue(n.Value)
		}
	case *js.ThrowStmt:
		if n.Value != nil {
			n.Value = r.rvalue(n.Value)
		}
	case *js.BlockStmt:
		r.walkBlockStmt(n)
	case *js.SwitchStmt:
		n.Init = r.rvalue(n.Init)
		for i := range n.List {
			c := &n.List[i]
			if c.Cond != nil {
				c.Cond = r.rvalue(c.Cond)
			}
			for j := range c.List {
				c.List[j] = r.walkStmt(c.List[j])
			}
		}
	case *js.TryStmt:
		r.walkBlockStmt(n.Body)
		if n.Catch != nil {
			r.walkBlockStmt(n.Catch)
		}
		if n.Finally != nil {
			r.walkBlockStmt(n.Finally)
		}
	case *js.LabelledStmt:
		n.Value = r.walkStmt(n.Value)
	case *js.FuncDecl:
		r.walkBlockStmt(&n.Body)
	case *js.ClassDecl:
		// Class bodies are handled inside their methods; tdewolff models
		// each as a FuncDecl-like node within the class. Skip for now —
		// nothing in the rule set needs to peek into class members.
	}
	return s
}

func (r *rewriter) walkStmtAsBlock(s js.IStmt) js.IStmt {
	if s == nil {
		return nil
	}
	return r.walkStmt(s)
}

func (r *rewriter) walkBindingElement(be *js.BindingElement) {
	if be == nil || be.Default == nil {
		return
	}
	be.Default = r.rvalue(be.Default)
}

// rvalue applies rule to expr in a value-read context, recurses into children
// first (post-order), then wraps the resulting node if applicable. Returns
// the (possibly wrapped) replacement node.
func (r *rewriter) rvalue(e js.IExpr) js.IExpr {
	if e == nil {
		return nil
	}
	switch n := e.(type) {
	case *js.BinaryExpr:
		// Recurse into both sides. Assignment `=` is handled specially —
		// the LHS is an lvalue, others are rvalues.
		if n.Op == js.EqToken {
			n.X = r.lvalue(n.X)
		} else {
			n.X = r.rvalue(n.X)
		}
		n.Y = r.rvalue(n.Y)
		return n

	case *js.CondExpr:
		n.Cond = r.rvalue(n.Cond)
		n.X = r.rvalue(n.X)
		n.Y = r.rvalue(n.Y)
		return n

	case *js.UnaryExpr:
		n.X = r.rvalue(n.X)
		return n

	case *js.GroupExpr:
		n.X = r.rvalue(n.X)
		return n

	case *js.CallExpr:
		// eval(...) — JS_WRAP_EVAL_ARG. Detect the bare-eval call BEFORE
		// recursing so we don't double-wrap by hitting WRAP_EVAL on the
		// callee identifier (we'd get $rewriter.wrap_eval_arg($rewriter.wrap_eval(eval),...)).
		// Also wrap the arg first, then skip it in the args loop below
		// to avoid wrapping the new wrapper itself.
		evalCall := r.opts.WrapEvalArg && isVar(n.X, "eval") && len(n.Args.List) > 0
		// import("url") — JS_WRAP_IMPORT_ARG. Dynamic import() is a keyword
		// expression whose callee parses as a LiteralExpr with data "import",
		// not as a regular identifier. Wrap the first arg (the specifier) so
		// the proxy can rewrite it to a ?goto= URL before the browser fetches
		// the module. Without this, import() calls bypass URL containment.
		importCall := r.opts.WrapImportArg && isImportExpr(n.X) && len(n.Args.List) > 0
		if evalCall {
			// Recurse into arg-0 before wrapping so any inner identifiers
			// (e.g. `eval(eval())`) get processed too.
			n.Args.List[0].Value = r.wrapEvalArg(r.rvalue(n.Args.List[0].Value))
		} else if importCall {
			arg := n.Args.List[0].Value
			if r.opts.BaseURL != nil && r.opts.ProxifyURL != nil {
				if lit, ok := arg.(*js.LiteralExpr); ok &&
					lit.TokenType == js.StringToken && len(lit.Data) >= 2 {
					// Static specifier: resolve + proxify now so the browser
					// fetches the right ?goto= URL regardless of the page's
					// base URL at call time.
					specifier := string(lit.Data[1 : len(lit.Data)-1])
					proxified := r.opts.ProxifyURL(specifier, r.opts.BaseURL)
					lit.Data = append(append([]byte{'"'}, []byte(proxified)...), '"')
					// lit is updated in place; no need to reassign the arg.
				} else {
					n.Args.List[0].Value = r.wrapImportArg(r.rvalue(arg))
				}
			} else {
				n.Args.List[0].Value = r.wrapImportArg(r.rvalue(arg))
			}
		} else {
			n.X = r.rvalue(n.X)
		}
		for i := range n.Args.List {
			if (evalCall || importCall) && i == 0 {
				continue
			}
			n.Args.List[i].Value = r.rvalue(n.Args.List[i].Value)
		}
		return n

	case *js.DotExpr:
		// `obj.X` — recurse into obj first, then maybe wrap based on X.
		// DotExpr.Y is IExpr (LiteralExpr or Var); pull out the property name
		// via type switch.
		n.X = r.rvalue(n.X)
		switch dotPropName(n) {
		case "location":
			if r.opts.WrapLocation {
				return r.wrapDotObj(n, "wrap_location")
			}
		case "top":
			if r.opts.WrapTopWindow {
				return r.wrapDotObj(n, "wrap_top_window")
			}
		case "parent":
			if r.opts.WrapParentWindow {
				return r.wrapDotObj(n, "wrap_parent_window")
			}
		case "write", "writeln":
			if r.opts.WrapDocumentWrite {
				return r.wrapDotObj(n, "wrap_document_write")
			}
		case "postMessage":
			if r.opts.WrapPostMessage {
				return r.wrapDotObj(n, "wrap_postMessage")
			}
		case "eval":
			if r.opts.WrapEvalMemexp {
				return r.wrapEvalMemexp(n)
			}
		}
		return n

	case *js.IndexExpr:
		// `obj[expr]` — JS_WRAP_MEMBER_EXPRESSION. Wraps both sides.
		n.X = r.rvalue(n.X)
		n.Y = r.rvalue(n.Y)
		// Skip optional-chain accesses (obj?.[key]): wrapping would lose the
		// ?. and turn safe null-guards into TypeError crashes.
		if r.opts.WrapMemberExpression && !n.Optional {
			return r.wrapMemberExpression(n)
		}
		return n

	case *js.Var:
		switch string(n.Data) {
		case "location":
			if r.opts.WrapGetLocation {
				return r.wrapCall("wrap_get_location", n)
			}
		case "top":
			if r.opts.WrapGetTopWindow {
				return r.wrapCall("wrap_get_top_window", n)
			}
		case "parent":
			// Both top and parent use wrap_get_top_window on the client side.
			if r.opts.WrapGetParentWindow {
				return r.wrapCall("wrap_get_top_window", n)
			}
		case "eval":
			if r.opts.WrapEval {
				return r.wrapCall("wrap_eval", n)
			}
		}
		return n

	case *js.ArrayExpr:
		for i := range n.List {
			n.List[i].Value = r.rvalue(n.List[i].Value)
		}
		return n

	case *js.ObjectExpr:
		for i := range n.List {
			if n.List[i].Value != nil {
				n.List[i].Value = r.rvalue(n.List[i].Value)
			}
		}
		return n

	case *js.TemplateExpr:
		for i := range n.List {
			n.List[i].Expr = r.rvalue(n.List[i].Expr)
		}
		return n

	case *js.NewExpr:
		n.X = r.rvalue(n.X)
		if n.Args != nil {
			for i := range n.Args.List {
				n.Args.List[i].Value = r.rvalue(n.Args.List[i].Value)
			}
		}
		return n

	case *js.YieldExpr:
		n.X = r.rvalue(n.X)
		return n

	case *js.ArrowFunc:
		// Function bodies are statements; recurse via walkBlockStmt.
		r.walkBlockStmt(&n.Body)
		return n

	case *js.FuncDecl:
		r.walkBlockStmt(&n.Body)
		return n

	case *js.ClassDecl:
		// Skip class internals for now — see walkStmt comment.
		return n
	}
	return e
}

// lvalue returns the rewritten left-hand side of an assignment.
//
// Two distinct cases:
//
//  1. The LHS is a bare `location` — JS_WRAP_SET_LOCATION fires, replacing
//     the LHS with the setter-pattern wrapper.
//  2. The LHS is a member access (`obj.X` or `obj[expr]`) — MemberExpression
//     rules fire here too (no distinction between lvalue and rvalue), so we
//     delegate to rvalue. This catches `obj.location =`,
//     `obj.top =`, `obj.eval =`, `obj[key] =` etc.
func (r *rewriter) lvalue(e js.IExpr) js.IExpr {
	if v, ok := e.(*js.Var); ok && string(v.Data) == "location" && r.opts.WrapSetLocation {
		return r.wrapSetLocation()
	}
	switch e.(type) {
	case *js.DotExpr, *js.IndexExpr:
		return r.rvalue(e)
	}
	return e
}

// ── helpers ──────────────────────────────────────────────────────────────────

// isVar reports whether e is a bare identifier with the given name.
func isVar(e js.IExpr, name string) bool {
	v, ok := e.(*js.Var)
	return ok && string(v.Data) == name
}

// isImportExpr reports whether e is the `import` keyword-callee of a dynamic
// import() call. tdewolff represents it as *js.LiteralExpr with data "import"
// (distinct from a Var identifier, since `import` is a reserved word).
func isImportExpr(e js.IExpr) bool {
	lit, ok := e.(*js.LiteralExpr)
	return ok && string(lit.Data) == "import"
}

// dotPropName returns the property name on a DotExpr's right-hand side.
// Empty if the property is something exotic (template, computed, etc).
//
// tdewolff stores DotExpr.Y as either *js.Var, js.LiteralExpr (by value!), or
// *js.LiteralExpr depending on parse path — the value-type LiteralExpr case
// surprised me until I added the type-switch case. Don't drop it.
func dotPropName(d *js.DotExpr) string {
	switch y := d.Y.(type) {
	case *js.Var:
		return string(y.Data)
	case *js.LiteralExpr:
		return string(y.Data)
	case js.LiteralExpr:
		return string(y.Data)
	}
	return ""
}

// parseExpr parses a JS expression source string into the corresponding AST
// node. Used to materialize wrapper templates. Templates are small enough
// that the parse cost per use is negligible compared to the surrounding
// transformation work; if it shows up in profiles we can cache.
func parseExpr(src string) js.IExpr {
	ast, err := js.Parse(parse.NewInputBytes([]byte(src+";")), js.Options{})
	if err != nil || len(ast.BlockStmt.List) == 0 {
		return nil
	}
	es, ok := ast.BlockStmt.List[0].(*js.ExprStmt)
	if !ok {
		return nil
	}
	return es.Value
}

// wrapCall builds `$rewriter.<helper>(<arg>)`. For wrap_get_location etc.
func (r *rewriter) wrapCall(helper string, arg js.IExpr) js.IExpr {
	tpl := parseExpr("$rewriter." + helper + "(__REWRITER_PLACEHOLDER__)")
	if tpl == nil {
		return arg
	}
	call, ok := tpl.(*js.CallExpr)
	if !ok || len(call.Args.List) == 0 {
		return arg
	}
	call.Args.List[0].Value = arg
	return call
}

// wrapDotObj rewrites `obj.X` to `$rewriter.<helper>({obj}).X` — used by
// WRAP_LOCATION, WRAP_TOP_WINDOW, WRAP_PARENT_WINDOW, WRAP_DOCUMENT_WRITE,
// and WRAP_POST_MESSAGE. The inner `{obj}` shorthand expands to `{obj: <X>}`.
func (r *rewriter) wrapDotObj(n *js.DotExpr, helper string) js.IExpr {
	tpl := parseExpr("$rewriter." + helper + "({obj:__REWRITER_PLACEHOLDER__})")
	if tpl == nil {
		return n
	}
	call, ok := tpl.(*js.CallExpr)
	if !ok || len(call.Args.List) == 0 {
		return n
	}
	objLit, ok := call.Args.List[0].Value.(*js.ObjectExpr)
	if !ok || len(objLit.List) == 0 {
		return n
	}
	objLit.List[0].Value = n.X
	n.X = call
	return n
}

// wrapImportArg rewrites the specifier of `import(spec)` →
// `$rewriter.wrap_import_arg(spec)` so the proxy can route the module load.
func (r *rewriter) wrapImportArg(arg js.IExpr) js.IExpr {
	tpl := parseExpr("$rewriter.wrap_import_arg(__REWRITER_PLACEHOLDER__)")
	if tpl == nil {
		return arg
	}
	call, ok := tpl.(*js.CallExpr)
	if !ok || len(call.Args.List) == 0 {
		return arg
	}
	call.Args.List[0].Value = arg
	return call
}

// wrapEvalArg rewrites `eval(src, ...)` first arg → `$rewriter.wrap_eval_arg(eval, src)`.
func (r *rewriter) wrapEvalArg(arg js.IExpr) js.IExpr {
	tpl := parseExpr("$rewriter.wrap_eval_arg(eval,__REWRITER_PLACEHOLDER__)")
	if tpl == nil {
		return arg
	}
	call, ok := tpl.(*js.CallExpr)
	if !ok || len(call.Args.List) < 2 {
		return arg
	}
	call.Args.List[1].Value = arg
	return call
}

// wrapEvalMemexp rewrites `obj.eval` → `$rewriter.wrap_eval_memexp(obj).eval`.
func (r *rewriter) wrapEvalMemexp(n *js.DotExpr) js.IExpr {
	tpl := parseExpr("$rewriter.wrap_eval_memexp(__REWRITER_PLACEHOLDER__)")
	if tpl == nil {
		return n
	}
	call, ok := tpl.(*js.CallExpr)
	if !ok || len(call.Args.List) == 0 {
		return n
	}
	call.Args.List[0].Value = n.X
	n.X = call
	return n
}

// wrapMemberExpression rewrites `obj[expr]` →
// `$rewriter.wrap_member_expression(obj, ($__crn_tmp__ = expr))[$__crn_tmp__]`.
// The sequence-expression on the index keeps `expr` evaluating exactly once
// while the call accesses obj's resolved property name.
func (r *rewriter) wrapMemberExpression(n *js.IndexExpr) js.IExpr {
	tpl := parseExpr("$rewriter.wrap_member_expression(__REWRITER_PLACEHOLDER_OBJ__, $__crn_tmp__ = __REWRITER_PLACEHOLDER_E__)[$__crn_tmp__]")
	if tpl == nil {
		return n
	}
	r.usedCrnTmp = true
	idx, ok := tpl.(*js.IndexExpr)
	if !ok {
		return n
	}
	call, ok := idx.X.(*js.CallExpr)
	if !ok || len(call.Args.List) < 2 {
		return n
	}
	call.Args.List[0].Value = n.X
	// Args[1] is `$__crn_tmp__ = E` — replace E.
	if assign, ok := call.Args.List[1].Value.(*js.BinaryExpr); ok {
		assign.Y = n.Y
	}
	return idx
}

// wrapSetLocation builds the LHS-of-assignment expression
// `$rewriter.wrap_set_location(location, function(v){location=v;}).value`.
// The `.value` setter on the returned object is what the assignment lands
// on, so writes flow through the wrapper.
func (r *rewriter) wrapSetLocation() js.IExpr {
	return parseExpr("$rewriter.wrap_set_location(location, function(v){location=v;}).value")
}

// dropPlaceholders removes any leftover __REWRITER_PLACEHOLDER_* identifiers
// (in case template-graft logic ever fails to substitute). Defensive — the
// rewriter shouldn't emit them, and tests assert against bytes.Contains to
// catch regressions.
func dropPlaceholders(src []byte) []byte {
	if !bytes.Contains(src, []byte("__REWRITER_PLACEHOLDER")) {
		return src
	}
	out := string(src)
	for _, marker := range []string{
		"__REWRITER_PLACEHOLDER_OBJ__",
		"__REWRITER_PLACEHOLDER_E__",
		"__REWRITER_PLACEHOLDER__",
	} {
		out = strings.ReplaceAll(out, marker, "undefined")
	}
	return []byte(out)
}
