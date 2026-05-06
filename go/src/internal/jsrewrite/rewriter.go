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
//   - WRAP_NEW_WORKER         — `new Worker(url)` / `new SharedWorker(url)` first arg
//
// alreadyRewritten() detects already-rewritten input (`$rewriter.wrap_` or
// `$rewriter_init(` substring) and short-circuits.
package jsrewrite

import (
	"bytes"
	"context"
	"fmt"
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
	WrapImportMetaUrl    bool
	WrapStaticImport     bool
	WrapNewWorker        bool

	// BaseURL is the URL of the script being rewritten. When set together
	// with ProxifyURL:
	//   - WrapImportArg: string-literal import() specifiers are resolved
	//     against this URL and proxified statically at rewrite time, bypassing
	//     the client-side wrap_import_arg.
	//   - WrapStaticImport: static `import … from "…"` and `export … from "…"`
	//     specifiers are resolved and proxified inline. This fixes ES-module
	//     chunk loading where relative specifiers would otherwise resolve to
	//     the proxy origin instead of the original module base URL.
	//   - WrapImportMetaUrl: import.meta.url is replaced with a string literal
	//     containing this URL, so ES-module entry points that compute chunk
	//     paths relative to import.meta.url see the original URL.
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
		WrapImportMetaUrl:    true,
		WrapStaticImport:     true,
		WrapNewWorker:        true,
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
		// Full AST parse failed. When WrapStaticImport is enabled and we have
		// a BaseURL + ProxifyURL, apply a simple byte-scan fallback that rewrites
		// ES module `import … from "url"` and `export … from "url"` specifiers.
		// This handles parse-incompatible minified bundles that still need their
		// static import specifiers proxified so the browser doesn't resolve them
		// relative to the proxy root (e.g. yielding /chunk-X.js instead of
		// /?goto=…/runtime/chunks/chunk-X.js).
		if opts.WrapStaticImport && opts.BaseURL != nil && opts.ProxifyURL != nil {
			return rewriteImportSpecifiersFallback(src, opts)
		}
		return src
	}
	r := &rewriter{opts: opts}
	r.walkBlockStmt(&ast.BlockStmt)

	var buf bytes.Buffer
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
	case *js.ImportStmt:
		// static `import … from "specifier"` — rewrite the specifier when
		// BaseURL+ProxifyURL are set so chunks are fetched via the proxy.
		// Without this, relative specifiers in ES-module entry points (Gatsby,
		// Vite) resolve against the proxy goto= URL and 404.
		if r.opts.WrapStaticImport && r.opts.BaseURL != nil && r.opts.ProxifyURL != nil && len(n.Module) >= 2 {
			n.Module = r.proxifyModuleSpecifier(n.Module)
		}
	case *js.ExportStmt:
		// `export … from "specifier"` — same rewrite policy as ImportStmt.
		if r.opts.WrapStaticImport && r.opts.BaseURL != nil && r.opts.ProxifyURL != nil && len(n.Module) >= 2 {
			n.Module = r.proxifyModuleSpecifier(n.Module)
		}
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
		// obj.write()/obj.writeln() — JS_WRAP_DOCUMENT_WRITE. Intercept at
		// the call site (not the DotExpr level) so that non-called reads of
		// `.write` as a data property (e.g. Prototype.js attribute translation
		// tables) are not replaced by the DocumentWriteWrapper function object.
		docWriteCall := false
		var docWriteDot *js.DotExpr
		if !evalCall && !importCall && r.opts.WrapDocumentWrite {
			if dot, ok := n.X.(*js.DotExpr); ok {
				prop := dotPropName(dot)
				if prop == "write" || prop == "writeln" {
					docWriteCall = true
					docWriteDot = dot
				}
			}
		}
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
		} else if docWriteCall {
			// Recurse into the object part (dot.X) only; skip wrapDotObj at
			// the DotExpr level so that bare `.write` property reads don't get
			// replaced by the wrapper.
			docWriteDot.X = r.rvalue(docWriteDot.X)
			n.X = r.wrapDotObj(docWriteDot, "wrap_document_write")
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

		// import.meta.url — replace with a string literal of the original
		// module URL. In an ES module served through the proxy, import.meta.url
		// is the proxy goto= URL (e.g. "http://proxy/?goto=b64(https://cdn/app.js)").
		// Frameworks like Gatsby compute chunk URLs as
		//   new URL('./chunk-X.js', import.meta.url)
		// which resolves against the proxy origin and 404s. By substituting the
		// known original URL we restore the correct base for those calculations.
		if r.opts.WrapImportMetaUrl && r.opts.BaseURL != nil && dotPropName(n) == "url" {
			if _, ok := n.X.(*js.ImportMetaExpr); ok {
				return &js.LiteralExpr{
					TokenType: js.StringToken,
					Data:      []byte(`"` + r.opts.BaseURL.String() + `"`),
				}
			}
		}

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
		// NOTE: write/writeln are NOT wrapped here — only at the CallExpr
		// level (see above) so that non-called property reads like
		// `obj.write.names` (Prototype.js attribute translation table) are
		// not replaced by the DocumentWriteWrapper function object.
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

	case *js.CommaExpr:
		for i := range n.List {
			n.List[i] = r.rvalue(n.List[i])
		}
		return n

	case *js.NewExpr:
		n.X = r.rvalue(n.X)
		// If the constructor expression was rewritten to a call-rooted chain
		// (e.g. IndexExpr whose left side is now a CallExpr after
		// wrapMemberExpression), JavaScript would parse
		//   new f(a)[k](args)
		// as (new f(a))[k](args) — invoking the property as a plain function
		// rather than as a constructor.  Wrap in GroupExpr (parens) so `new`
		// binds to the whole expression:
		//   new (f(a)[k])(args)
		if isCallRooted(n.X) {
			n.X = &js.GroupExpr{X: n.X}
		}
		if n.Args != nil {
			// Rewrite url argument of `new Worker(url, ...)` /
			// `new SharedWorker(url, ...)` so the Worker script is fetched
			// through the proxy even when page code restores the native
			// Worker constructor (e.g. reCAPTCHA anti-tampering).
			if r.opts.WrapNewWorker && len(n.Args.List) > 0 {
				if v, ok := n.X.(*js.Var); ok {
					name := string(v.Data)
					if name == "Worker" || name == "SharedWorker" {
						n.Args.List[0].Value = r.wrapWorkerUrl(n.Args.List[0].Value)
					}
				}
			}
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

// isCallRooted reports whether the left-most expression in a member chain is a
// CallExpr.  When this is true, the expression cannot be used directly as the
// callee of a `new` statement: `new f(a)[k](x)` parses as `(new f(a))[k](x)`,
// calling `[k]` as a plain function rather than a constructor.  The caller must
// wrap the expression in a GroupExpr (parentheses) to force correct binding.
func isCallRooted(e js.IExpr) bool {
	switch x := e.(type) {
	case *js.CallExpr:
		return true
	case *js.IndexExpr:
		return isCallRooted(x.X)
	case *js.DotExpr:
		return isCallRooted(x.X)
	}
	return false
}

// proxifyModuleSpecifier rewrites a static import/export module specifier
// (the raw quoted bytes from *js.ImportStmt.Module or *js.ExportStmt.Module,
// e.g. `"./chunks/chunk-X.js"`) by stripping the surrounding quotes, resolving
// the specifier against BaseURL, passing it through ProxifyURL, and
// re-quoting the result. Returns the input unchanged when the specifier is
// not a string literal, is empty after stripping, or ProxifyURL returns it
// unchanged (bare specifiers like "react" pass through).
func (r *rewriter) proxifyModuleSpecifier(raw []byte) []byte {
	if len(raw) < 2 {
		return raw
	}
	q := raw[0]
	if q != '"' && q != '\'' && q != '`' {
		return raw
	}
	inner := string(raw[1 : len(raw)-1])
	proxified := r.opts.ProxifyURL(inner, r.opts.BaseURL)
	if proxified == inner {
		return raw
	}
	out := make([]byte, 0, 2+len(proxified))
	out = append(out, '"')
	out = append(out, []byte(proxified)...)
	out = append(out, '"')
	return out
}

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

// wrapWorkerUrl rewrites the url argument of `new Worker(url)` or
// `new SharedWorker(url)` → `$rewriter.wrap_worker_url(url)`.
// This runs at the source level so the URL is proxied even when page code
// restores the native Worker constructor (e.g. reCAPTCHA anti-tampering).
func (r *rewriter) wrapWorkerUrl(arg js.IExpr) js.IExpr {
	tpl := parseExpr("$rewriter.wrap_worker_url(__REWRITER_PLACEHOLDER__)")
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
// `$rewriter.wrap_member_expression(obj, ($__crn_key__ = expr))[$__crn_key__]`.
//
// A single shared key variable is safe: JavaScript evaluates function arguments
// strictly left-to-right, so for nested accesses like obj[a][b] the inner
// assignment ($__crn_key__ = a) completes and is used before the outer
// ($__crn_key__ = b) runs. The variable is published as window.$__crn_key__ by
// the client bootstrap so strict-mode eval'd fragments can assign to it.
func (r *rewriter) wrapMemberExpression(n *js.IndexExpr) js.IExpr {
	const varName = "$__crn_key__"
	tpl := parseExpr(fmt.Sprintf(
		"$rewriter.wrap_member_expression(__REWRITER_PLACEHOLDER_OBJ__, %s = __REWRITER_PLACEHOLDER_E__)[%s]",
		varName, varName,
	))
	if tpl == nil {
		return n
	}
	idx, ok := tpl.(*js.IndexExpr)
	if !ok {
		return n
	}
	call, ok := idx.X.(*js.CallExpr)
	if !ok || len(call.Args.List) < 2 {
		return n
	}
	call.Args.List[0].Value = n.X
	// Args[1] is `$__crn_key__ = E` — replace E.
	// If E is a comma expression (e.g. `N[a, b]`), it must be parenthesized:
	// `$var = (a, b)` so the comma is the RHS of the assignment, not a
	// second function argument. Without parens the printer emits
	// `wrap_member_expression(N, $var = a, b)` which passes b as a third
	// arg and assigns the wrong value to $var.
	if assign, ok := call.Args.List[1].Value.(*js.BinaryExpr); ok {
		key := n.Y
		if _, isComma := key.(*js.CommaExpr); isComma {
			key = &js.GroupExpr{X: key}
		}
		assign.Y = key
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

// rewriteImportSpecifiersFallback is a best-effort byte-scan fallback for
// modules that fail AST parsing. It finds `from "url"` / `from 'url'` patterns
// (including bare `import "url"` side-effect imports and export-from) and
// rewrites the specifier through ProxifyURL, leaving everything else unchanged.
//
// The scan is conservative: it only rewrites inside the first contiguous block
// of import/export statements at the top of the file (stopping at the first
// non-whitespace byte that isn't one of those keywords). This prevents false
// rewrites inside string literals or comments elsewhere in the file.
func rewriteImportSpecifiersFallback(src []byte, opts Options) []byte {
	var out []byte
	n := len(src)
	flushed := 0 // how much of src has been copied to out
	i := 0

	// flush copies src[flushed:end] to out, ensuring out is initialised.
	flush := func(end int) {
		if out == nil {
			out = make([]byte, 0, len(src)+256)
		}
		out = append(out, src[flushed:end]...)
		flushed = end
	}

	// readQuoted reads one quoted string starting at pos, returning the quote
	// char, the inner bytes, and the position after the closing quote.
	// Returns 0, nil, pos on failure.
	readQuoted := func(pos int) (byte, []byte, int) {
		if pos >= n {
			return 0, nil, pos
		}
		q := src[pos]
		if q != '"' && q != '\'' {
			return 0, nil, pos
		}
		start := pos + 1
		for p := start; p < n; p++ {
			c := src[p]
			if c == '\\' {
				p++
				continue
			}
			if c == q {
				return q, src[start:p], p + 1
			}
		}
		return 0, nil, pos // unterminated — give up
	}

	// rewriteSpecifier rewrites the quoted specifier at quotePos using
	// ProxifyURL. If the URL is unchanged, leaves src untouched.
	rewriteSpecifier := func(quotePos int) (newI int, ok bool) {
		q, inner, after := readQuoted(quotePos)
		if q == 0 {
			return quotePos, false
		}
		specifier := string(inner)
		proxified := opts.ProxifyURL(specifier, opts.BaseURL)
		if proxified == specifier {
			// URL unchanged — skip, but advance past the quoted string.
			return after, false
		}
		flush(quotePos) // copy everything up to the opening quote
		if out == nil {
			out = make([]byte, 0, len(src)+256)
		}
		out = append(out, q)
		out = append(out, proxified...)
		out = append(out, q)
		flushed = after
		return after, true
	}

	for i < n {
		// Skip whitespace and semicolons between statements.
		for i < n && (src[i] == ' ' || src[i] == '\t' || src[i] == '\r' || src[i] == '\n' || src[i] == ';') {
			i++
		}
		if i >= n {
			break
		}

		// We only touch `import` and `export` keywords.
		keyword := ""
		if i+6 <= n && string(src[i:i+6]) == "import" && (i+6 >= n || !isIdentChar(src[i+6])) {
			keyword = "import"
		} else if i+6 <= n && string(src[i:i+6]) == "export" && (i+6 >= n || !isIdentChar(src[i+6])) {
			keyword = "export"
		} else {
			// Non-import/export statement — stop scanning.
			break
		}

		i += len(keyword)

		// Scan to end of statement: find `from "url"` or a side-effect
		// `import "url"`, stopping at `;` or newline as a bail-out.
		for i < n && src[i] != ';' && src[i] != '\n' {
			// Side-effect `import "url"` — quote immediately follows import keyword+space.
			if (src[i] == '"' || src[i] == '\'') && keyword == "import" {
				i, _ = rewriteSpecifier(i)
				break
			}
			// `from "url"` or `from 'url'`
			if i+4 <= n && string(src[i:i+4]) == "from" && (i+4 >= n || !isIdentChar(src[i+4])) {
				j := i + 4
				for j < n && (src[j] == ' ' || src[j] == '\t') {
					j++
				}
				if j < n && (src[j] == '"' || src[j] == '\'') {
					i, _ = rewriteSpecifier(j)
					break
				}
			}
			i++
		}
	}

	if out == nil {
		return src
	}
	// Flush remaining src (from last rewritten specifier to end).
	out = append(out, src[flushed:]...)
	return out
}

// isIdentChar reports whether c can appear inside a JS identifier.
func isIdentChar(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '$'
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
