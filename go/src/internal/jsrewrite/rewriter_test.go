package jsrewrite

import (
	"net/url"
	"strings"
	"testing"
)

// rewrite is a thin helper — string-in, string-out, default options.
func rewrite(t *testing.T, in string) string {
	t.Helper()
	return string(Rewrite([]byte(in), DefaultOptions()))
}

// rewriteWith runs Rewrite with a single rule enabled (everything else off).
func rewriteWith(t *testing.T, in string, opts Options) string {
	t.Helper()
	return string(Rewrite([]byte(in), opts))
}

// ── WRAP_GET_LOCATION ───────────────────────────────────────────────────────

func TestWrapGetLocation_RvalueAssign(t *testing.T) {
	got := rewrite(t, `var x = location;`)
	if !strings.Contains(got, `$rewriter.wrap_get_location(location)`) {
		t.Errorf("got: %s", got)
	}
}

func TestWrapGetLocation_ArgumentInCall(t *testing.T) {
	got := rewrite(t, `f(location);`)
	if !strings.Contains(got, `$rewriter.wrap_get_location(location)`) {
		t.Errorf("got: %s", got)
	}
}

func TestWrapGetLocation_LeftAlone_WhenLvalue(t *testing.T) {
	// `location = X` — LHS is lvalue, get_location must NOT fire there.
	got := rewrite(t, `location = "x";`)
	if strings.Contains(got, `wrap_get_location(location)`) {
		t.Errorf("get_location fired in lvalue position: %s", got)
	}
}

// ── WRAP_SET_LOCATION ───────────────────────────────────────────────────────

func TestWrapSetLocation_BareAssignment(t *testing.T) {
	got := rewrite(t, `location = "https://example.com";`)
	if !strings.Contains(got, `$rewriter.wrap_set_location`) {
		t.Errorf("set_location wrapper missing: %s", got)
	}
	if !strings.Contains(got, `).value`) {
		t.Errorf("setter `.value` accessor missing: %s", got)
	}
}

// ── WRAP_LOCATION ───────────────────────────────────────────────────────────

func TestWrapLocation_DotAccess(t *testing.T) {
	got := rewrite(t, `window.location = "x";`)
	if !strings.Contains(got, `$rewriter.wrap_location({obj`) {
		t.Errorf("wrap_location on obj.location missing: %s", got)
	}
}

func TestWrapLocation_OnArbitraryObject(t *testing.T) {
	got := rewrite(t, `iframe.contentWindow.location = "x";`)
	if !strings.Contains(got, `wrap_location`) {
		t.Errorf("wrap_location on chained obj.location missing: %s", got)
	}
}

// ── WRAP_GET_TOP_WINDOW / WRAP_GET_PARENT_WINDOW ────────────────────────────

func TestWrapGetTopWindow(t *testing.T) {
	got := rewrite(t, `var x = top;`)
	if !strings.Contains(got, `$rewriter.wrap_get_top_window(top)`) {
		t.Errorf("wrap_get_top_window missing: %s", got)
	}
}

func TestWrapGetParentWindow_ReusesGetTopWindow(t *testing.T) {
	// wrap_get_top_window is reused for both top and parent rvalues
	// to keep client API surface small.
	got := rewrite(t, `var x = parent;`)
	if !strings.Contains(got, `$rewriter.wrap_get_top_window(parent)`) {
		t.Errorf("parent rvalue should call wrap_get_top_window: %s", got)
	}
}

// ── WRAP_TOP_WINDOW / WRAP_PARENT_WINDOW (member access) ────────────────────

func TestWrapTopWindow_DotAccess(t *testing.T) {
	got := rewrite(t, `obj.top = w;`)
	if !strings.Contains(got, `$rewriter.wrap_top_window({obj`) {
		t.Errorf("wrap_top_window on obj.top missing: %s", got)
	}
}

func TestWrapParentWindow_DotAccess(t *testing.T) {
	got := rewrite(t, `obj.parent = w;`)
	if !strings.Contains(got, `$rewriter.wrap_parent_window({obj`) {
		t.Errorf("wrap_parent_window on obj.parent missing: %s", got)
	}
}

// ── WRAP_DOCUMENT_WRITE ─────────────────────────────────────────────────────

func TestWrapDocumentWrite(t *testing.T) {
	got := rewrite(t, `document.write("<p>hi</p>");`)
	if !strings.Contains(got, `$rewriter.wrap_document_write({obj`) {
		t.Errorf("wrap_document_write missing: %s", got)
	}
}

func TestWrapDocumentWriteln(t *testing.T) {
	got := rewrite(t, `document.writeln("hi");`)
	if !strings.Contains(got, `wrap_document_write`) {
		t.Errorf("wrap_document_write should also catch writeln: %s", got)
	}
}

func TestWrapDocumentWrite_PropertyRead_NotWrapped(t *testing.T) {
	// Prototype.js accesses `Element._attributeTranslations.write.names` —
	// `.write` as a data property, not a call.  It must NOT be replaced by
	// the DocumentWriteWrapper function object or `.names` will be undefined.
	got := rewrite(t, `var w = t.write;`)
	if strings.Contains(got, "wrap_document_write") {
		t.Errorf("bare property read of .write must not be wrapped: %s", got)
	}
}

func TestWrapDocumentWrite_CallIsWrapped(t *testing.T) {
	// Calling .write() must still be intercepted even after moving the rule
	// from DotExpr level to CallExpr level.
	got := rewrite(t, `someObj.write("html");`)
	if !strings.Contains(got, "wrap_document_write") {
		t.Errorf("call to .write() must be wrapped: %s", got)
	}
}

func TestWrapDocumentWrite_NestedObjectWrite_NotWrapped(t *testing.T) {
	// `t.write.names` — chained reads; neither `.write` nor `.names` should
	// be wrapped because there is no call in this expression.
	got := rewrite(t, `var n = t.write.names;`)
	if strings.Contains(got, "wrap_document_write") {
		t.Errorf("chained read of .write.names must not wrap .write: %s", got)
	}
}

// ── WRAP_POST_MESSAGE ───────────────────────────────────────────────────────

func TestWrapPostMessage(t *testing.T) {
	got := rewrite(t, `window.postMessage(msg, origin);`)
	if !strings.Contains(got, `$rewriter.wrap_postMessage({obj`) {
		t.Errorf("wrap_postMessage missing: %s", got)
	}
}

func TestWrapPostMessage_ChainedReceiver(t *testing.T) {
	got := rewrite(t, `iframe.contentWindow.postMessage(msg, origin);`)
	if !strings.Contains(got, `wrap_postMessage`) {
		t.Errorf("wrap_postMessage on chained receiver missing: %s", got)
	}
}


// ── WRAP_EVAL / EVAL_ARG / EVAL_MEMEXP ──────────────────────────────────────

func TestWrapEval_RvalueOnly(t *testing.T) {
	got := rewrite(t, `var f = eval;`)
	if !strings.Contains(got, `$rewriter.wrap_eval(eval)`) {
		t.Errorf("wrap_eval missing: %s", got)
	}
}

func TestWrapEvalArg_DirectCall(t *testing.T) {
	got := rewrite(t, `eval("var one = 1;");`)
	if !strings.Contains(got, `$rewriter.wrap_eval_arg(eval`) {
		t.Errorf("wrap_eval_arg on direct call missing: %s", got)
	}
}

func TestWrapEval_DirectCall_DoesNotDoubleApply(t *testing.T) {
	// eval(...) should fire WRAP_EVAL_ARG, not WRAP_EVAL — the bare eval
	// in callee position is the call target, not an rvalue read.
	got := rewrite(t, `eval(src);`)
	// eval_arg on the inner src
	if !strings.Contains(got, `wrap_eval_arg(eval`) {
		t.Errorf("expected wrap_eval_arg: %s", got)
	}
	// shouldn't also wrap the callee with wrap_eval — that would be
	// `$rewriter.wrap_eval(eval)(...)`, which is also valid but redundant.
	// Wrap the arg only — wrapping the callee too would be redundant.
	if strings.Contains(got, `wrap_eval(eval)(`) {
		t.Errorf("double-wrapped eval call: %s", got)
	}
}

func TestWrapEvalMemexp(t *testing.T) {
	got := rewrite(t, `obj.eval("x");`)
	if !strings.Contains(got, `$rewriter.wrap_eval_memexp(obj)`) {
		t.Errorf("wrap_eval_memexp missing: %s", got)
	}
}

// ── WRAP_MEMBER_EXPRESSION ──────────────────────────────────────────────────

func TestWrapMemberExpression(t *testing.T) {
	got := rewrite(t, `var v = obj[key];`)
	if !strings.Contains(got, `$rewriter.wrap_member_expression(obj`) {
		t.Errorf("wrap_member_expression missing: %s", got)
	}
}

func TestWrapMemberExpression_CommaIndex(t *testing.T) {
	// obj[a, b] — comma operator inside index. The comma must become part of
	// the assignment RHS, not a third function argument:
	//   wrap_member_expression(obj, ($var = (a, b)))[$var]
	// Without parenthesising (a,b), the printer emits
	//   wrap_member_expression(obj, $var = a, b)
	// which assigns a to $var and passes b as a third arg — accessing obj[a]
	// instead of the correct obj[b].
	got := rewrite(t, `var v = N[GI.prototype.h = z[0](3, xG), 11];`)
	// The assignment must capture the full comma expression.
	if !strings.Contains(got, `= (`) {
		t.Errorf("comma index not parenthesised in assignment: %s", got)
	}
	// 11 must NOT appear as a third argument to wrap_member_expression.
	if strings.Contains(got, `wrap_member_expression(N,`) && strings.Contains(got, `, 11)`) {
		t.Errorf("11 leaked as third arg to wrap_member_expression: %s", got)
	}
}

// ── alreadyRewritten short-circuit ──────────────────────────────────────────

func TestAlreadyRewritten_Untouched(t *testing.T) {
	in := `var x = $rewriter.wrap_get_location(location);`
	got := rewrite(t, in)
	if got != in {
		t.Errorf("already-rewritten code mutated:\n in:  %s\n out: %s", in, got)
	}
}

func TestAlreadyRewritten_RewriterInit(t *testing.T) {
	in := `window.$rewriter = window.$rewriter_init(window, {}).inject();`
	got := rewrite(t, in)
	if got != in {
		t.Errorf("rewriter_init bootstrap mutated:\n in:  %s\n out: %s", in, got)
	}
}

// ── Parse failure → identity ────────────────────────────────────────────────

func TestUnparseableInput_PassesThrough(t *testing.T) {
	in := `this is not js {{{`
	got := rewrite(t, in)
	if got != in {
		t.Errorf("invalid JS should pass through:\n in:  %s\n out: %s", in, got)
	}
}

// ── Per-rule isolation ──────────────────────────────────────────────────────

func TestRuleIsolation_OnlyGetLocation(t *testing.T) {
	got := rewriteWith(t, `var x = location; eval("x");`, Options{WrapGetLocation: true})
	if !strings.Contains(got, `wrap_get_location(location)`) {
		t.Errorf("expected wrap_get_location: %s", got)
	}
	if strings.Contains(got, `wrap_eval`) {
		t.Errorf("eval rules should be off: %s", got)
	}
}

func TestRuleIsolation_NoOptionsIsIdentity(t *testing.T) {
	in := `location = "x"; var y = top; eval("z");`
	got := rewriteWith(t, in, Options{})
	if !strings.Contains(got, `location =`) || !strings.Contains(got, `top`) || !strings.Contains(got, `eval(`) {
		t.Errorf("with no rules enabled the body should be untouched: %s", got)
	}
	if strings.Contains(got, `wrap_`) {
		t.Errorf("with no rules enabled, no wrappers should appear: %s", got)
	}
}

// ── Combined: realistic patterns ──────────────────────────────────────────

func TestRealistic_LocationReadAndWrite(t *testing.T) {
	in := `if (location.host === "example.com") { location = "https://other"; }`
	got := rewrite(t, in)
	// Read of location.host: the bare `location` rvalue inside the dot
	// expression gets wrapped with wrap_get_location (JS_WRAP_GET_LOCATION
	// fires on `location` Var in rvalue contexts). The `.host` access stays
	// as a plain DotExpr.
	if !strings.Contains(got, `wrap_get_location(location)`) {
		t.Errorf("location.host read should wrap the location identifier: %s", got)
	}
	// Write to location wraps via set_location
	if !strings.Contains(got, `wrap_set_location`) {
		t.Errorf("location write should wrap: %s", got)
	}
}

func TestRealistic_NestedEval(t *testing.T) {
	in := `function run(src) { eval(src); }`
	got := rewrite(t, in)
	if !strings.Contains(got, `wrap_eval_arg(eval`) {
		t.Errorf("eval inside function should still be wrapped: %s", got)
	}
}

// ── Idempotence ─────────────────────────────────────────────────────────────

func TestIdempotent(t *testing.T) {
	in := `location = "x"; var y = location; obj.postMessage(m, o);`
	once := rewrite(t, in)
	twice := rewrite(t, once)
	if once != twice {
		t.Errorf("rewrite is not idempotent:\n once:  %s\n twice: %s", once, twice)
	}
}

// ── $__crn_key__ usage in wrap_member_expression ────────────────────────────
//
// wrap_member_expression uses a single shared variable $__crn_key__ to capture
// the computed key. JS left-to-right evaluation order makes this safe even for
// nested bracket accesses: each assignment completes and is consumed before the
// next one runs. The variable is published as window.$__crn_key__ by the client
// bootstrap so strict-mode eval'd fragments can assign to it without a var decl.

func TestWrapMemberExpression_UsesCrnKey(t *testing.T) {
	in := `var x = obj["dynamic" + key];`
	got := rewrite(t, in)
	if !strings.Contains(got, "$__crn_key__") {
		t.Errorf("expected $__crn_key__ in output, got: %s", got)
	}
	if !strings.Contains(got, "$rewriter.wrap_member_expression") {
		t.Errorf("wrap_member_expression should fire on bracket access: %s", got)
	}
}

func TestWrapMemberExpression_NoPreambleWhenUnused(t *testing.T) {
	in := `var x = location;`
	got := rewrite(t, in)
	if strings.Contains(got, "$__crn_key__") {
		t.Errorf("$__crn_key__ should NOT appear when wrap_member_expression didn't fire: %s", got)
	}
}

// Multiple bracket accesses share a single $__crn_key__ — safe because JS
// evaluates left-to-right so each assignment completes before the next runs.
func TestWrapMemberExpression_SharedKeyForMultipleSites(t *testing.T) {
	in := `var a = obj[x]; var b = obj[y];`
	got := rewrite(t, in)
	count := strings.Count(got, "$__crn_key__")
	if count < 4 {
		t.Errorf("expected $__crn_key__ to appear at least 4 times (assign+read x2), got %d: %s", count, got)
	}
}

// Re-rewriting idempotent: feeding output back through the rewriter is a no-op.
func TestWrapMemberExpression_IdempotentRewrite(t *testing.T) {
	in := `"use strict"; var v = obj[key];`
	got := rewrite(t, in)
	twice := rewrite(t, got)
	if got != twice {
		t.Errorf("re-rewriting output drifted:\nonce: %s\ntwice: %s", got, twice)
	}
}

// ── WRAP_IMPORT_ARG ─────────────────────────────────────────────────────────

func TestWrapImportArg_AbsoluteURL(t *testing.T) {
	got := rewrite(t, `import("https://cdn.example.com/module.js");`)
	if !strings.Contains(got, `$rewriter.wrap_import_arg("https://cdn.example.com/module.js")`) {
		t.Errorf("import specifier not wrapped: %s", got)
	}
}

func TestWrapImportArg_RelativePath(t *testing.T) {
	got := rewrite(t, `import("/static/chunk-abc.js");`)
	if !strings.Contains(got, `$rewriter.wrap_import_arg("/static/chunk-abc.js")`) {
		t.Errorf("relative import not wrapped: %s", got)
	}
}

func TestWrapImportArg_DynamicSpecifier(t *testing.T) {
	// import(someVariable) — wrap the expression, not just string literals.
	got := rewrite(t, `import(getModulePath());`)
	if !strings.Contains(got, `$rewriter.wrap_import_arg(`) {
		t.Errorf("dynamic-expression import not wrapped: %s", got)
	}
}

func TestWrapImportArg_PreservesChain(t *testing.T) {
	// import(...).then(...) — the promise chain must survive.
	got := rewrite(t, `import("mod.js").then(m => m.init());`)
	if !strings.Contains(got, `$rewriter.wrap_import_arg("mod.js")`) {
		t.Errorf("import chain lost wrapper: %s", got)
	}
	if !strings.Contains(got, `.then(`) {
		t.Errorf("promise chain dropped: %s", got)
	}
}

func TestWrapImportArg_NotFiredWhenDisabled(t *testing.T) {
	got := rewriteWith(t, `import("mod.js");`, Options{WrapImportArg: false})
	if strings.Contains(got, "wrap_import_arg") {
		t.Errorf("wrap_import_arg fired when disabled: %s", got)
	}
}

func TestWrapImportArg_DoesNotWrapStaticImport(t *testing.T) {
	// Static `import x from "mod"` is an ImportStmt, not a CallExpr.
	// The rule must not fire on it.
	got := rewrite(t, `import x from "mod.js";`)
	if strings.Contains(got, "wrap_import_arg") {
		t.Errorf("wrap_import_arg incorrectly fired on static import: %s", got)
	}
}

// ── Static import() proxification (BaseURL + ProxifyURL) ────────────────────
// When the rewriter has a BaseURL and ProxifyURL callback, string-literal
// import() specifiers are resolved and proxified at rewrite time.

func mustParseURL(s string) *url.URL {
	u, err := url.Parse(s)
	if err != nil {
		panic(err)
	}
	return u
}

func staticProxify(rawURL string, base *url.URL) string {
	resolved, err := base.Parse(rawURL)
	if err != nil || resolved == nil {
		return rawURL
	}
	escapedPath := resolved.EscapedPath()
	if escapedPath == "" {
		escapedPath = "/"
	}
	return "https://proxy.example.com/cyrano/" + resolved.Scheme + "/" + resolved.Host + escapedPath
}

func TestWrapImportArg_StaticStringLiteral_AbsoluteURL(t *testing.T) {
	base := mustParseURL("https://cdn.example.com/assets/main.js")
	opts := DefaultOptions()
	opts.BaseURL = base
	opts.ProxifyURL = staticProxify

	got := rewriteWith(t, `import("https://other.example.com/mod.js");`, opts)
	want := `"https://proxy.example.com/cyrano/https/other.example.com/mod.js"`
	if !strings.Contains(got, want) {
		t.Errorf("expected %s in: %s", want, got)
	}
	if strings.Contains(got, "wrap_import_arg") {
		t.Errorf("wrap_import_arg should not fire for static specifier: %s", got)
	}
}

func TestWrapImportArg_StaticStringLiteral_RelativePath(t *testing.T) {
	base := mustParseURL("https://cdn.example.com/assets/main.js")
	opts := DefaultOptions()
	opts.BaseURL = base
	opts.ProxifyURL = staticProxify

	// ./chunk.js should resolve against the module URL, not the page URL.
	got := rewriteWith(t, `import("./chunk-abc.js");`, opts)
	want := `"https://proxy.example.com/cyrano/https/cdn.example.com/assets/chunk-abc.js"`
	if !strings.Contains(got, want) {
		t.Errorf("expected %s in: %s", want, got)
	}
	if strings.Contains(got, "wrap_import_arg") {
		t.Errorf("wrap_import_arg should not fire for static specifier: %s", got)
	}
}

func TestWrapImportArg_StaticStringLiteral_DynamicFallsBack(t *testing.T) {
	base := mustParseURL("https://cdn.example.com/assets/main.js")
	opts := DefaultOptions()
	opts.BaseURL = base
	opts.ProxifyURL = staticProxify

	// Non-literal specifiers must still use wrap_import_arg.
	got := rewriteWith(t, `import(getPath());`, opts)
	if !strings.Contains(got, "wrap_import_arg") {
		t.Errorf("wrap_import_arg should fire for dynamic specifier: %s", got)
	}
}

func TestWrapImportArg_NoBaseURL_FallsBackToWrap(t *testing.T) {
	// No BaseURL set — must still wrap the specifier at runtime.
	opts := DefaultOptions()
	// BaseURL and ProxifyURL intentionally omitted.

	got := rewriteWith(t, `import("./mod.js");`, opts)
	if !strings.Contains(got, "wrap_import_arg") {
		t.Errorf("wrap_import_arg should fire when BaseURL is absent: %s", got)
	}
}

// ── NewExpr + wrap_member_expression precedence ─────────────────────────────
//
// `new obj[key](args)` must NOT become `new wrap(obj,...)[key](args)` verbatim,
// because JavaScript would parse that as `(new wrap(...))[key](args)` — calling
// the property as a plain function.  The rewriter must parenthesise the callee
// so `new` binds to the full bracketed expression.

func TestNewExpr_ComputedConstructor_GetsParens(t *testing.T) {
	// Simulates: new globalThis[TypedArrayName](n)
	// The bracketed callee is wrapped by wrap_member_expression; without parens
	// `new wrap_member_expression(...)[k](n)` would invoke k as a plain
	// function → "Constructor BigInt64Array requires 'new'".
	got := rewrite(t, `new obj[key](n);`)
	// After fix: new ($rewriter.wrap_member_expression(obj,...)[...])(n)
	if !strings.Contains(got, "new (") {
		t.Errorf("callee not parenthesised — new will bind to CallExpr not IndexExpr: %s", got)
	}
	// Must not have the bare un-parenthesised form.
	if strings.Contains(got, "new $rewriter.wrap_member_expression") &&
		!strings.Contains(got, "new ($rewriter.wrap_member_expression") {
		t.Errorf("wrap_member_expression callee must be in parens: %s", got)
	}
}

func TestNewExpr_PlainConstructor_NoParens(t *testing.T) {
	// Plain `new Foo(x)` — no rewriting, no unnecessary parens.
	got := rewrite(t, `new Foo(x);`)
	if strings.Contains(got, "new (") {
		t.Errorf("plain new Foo should not get extra parens: %s", got)
	}
	if !strings.Contains(got, "new Foo(") {
		t.Errorf("plain new Foo should be unchanged: %s", got)
	}
}

func TestNewExpr_StaticMemberConstructor_NoParens(t *testing.T) {
	// `new a.b()` — static member, no wrap, no extra parens.
	got := rewrite(t, `new a.b();`)
	if strings.Contains(got, "new (") {
		t.Errorf("new a.b() should not get extra parens: %s", got)
	}
}

// ── WrapImportMetaUrl ────────────────────────────────────────────────────────
//
// ES-module entry points (Gatsby, Vite, webpack 5) use `import.meta.url` to
// compute the base URL for dynamic chunk loads. When the module is served
// through the proxy, import.meta.url returns the proxy goto= URL rather than
// the original module URL, so relative chunk paths resolve to the proxy origin
// and 404. The rewriter replaces import.meta.url with the known original URL.

func TestWrapImportMetaUrl_ReplacedWithBaseURL(t *testing.T) {
	base := mustParseURL("https://cdn.example.com/assets/browser-entry.js")
	opts := DefaultOptions()
	opts.BaseURL = base

	got := rewriteWith(t, `var u = import.meta.url;`, opts)
	want := `"https://cdn.example.com/assets/browser-entry.js"`
	if !strings.Contains(got, want) {
		t.Errorf("import.meta.url not replaced with BaseURL: %s", got)
	}
	if strings.Contains(got, "import.meta.url") {
		t.Errorf("import.meta.url must not appear in output: %s", got)
	}
}

func TestWrapImportMetaUrl_NoBaseURL_PassesThrough(t *testing.T) {
	// When BaseURL is not set, import.meta.url can't be substituted — leave it.
	opts := DefaultOptions()
	// BaseURL intentionally omitted.

	got := rewriteWith(t, `var u = import.meta.url;`, opts)
	if !strings.Contains(got, "import.meta.url") {
		t.Errorf("import.meta.url should pass through when BaseURL is absent: %s", got)
	}
}

func TestWrapImportMetaUrl_FlagOff_PassesThrough(t *testing.T) {
	base := mustParseURL("https://cdn.example.com/app.js")
	opts := DefaultOptions()
	opts.BaseURL = base
	opts.WrapImportMetaUrl = false

	got := rewriteWith(t, `var u = import.meta.url;`, opts)
	if !strings.Contains(got, "import.meta.url") {
		t.Errorf("import.meta.url should pass through when WrapImportMetaUrl is false: %s", got)
	}
}

func TestWrapImportMetaUrl_UsedInNewURL(t *testing.T) {
	// Simulates: new URL('./chunk-X.js', import.meta.url)
	base := mustParseURL("https://cdn.example.com/assets/entry.js")
	opts := DefaultOptions()
	opts.BaseURL = base

	got := rewriteWith(t, `new URL('./chunk.js', import.meta.url);`, opts)
	want := `"https://cdn.example.com/assets/entry.js"`
	if !strings.Contains(got, want) {
		t.Errorf("import.meta.url not replaced in new URL() call: %s", got)
	}
}

func TestWrapImportMetaUrl_ImportMetaOtherProp_NotReplaced(t *testing.T) {
	// import.meta.hot (Vite HMR) and other import.meta properties must not
	// be replaced — only import.meta.url.
	base := mustParseURL("https://cdn.example.com/app.js")
	opts := DefaultOptions()
	opts.BaseURL = base

	got := rewriteWith(t, `var h = import.meta.hot;`, opts)
	if strings.Contains(got, `"https://cdn.example.com/app.js"`) {
		t.Errorf("import.meta.hot should not be replaced: %s", got)
	}
	if !strings.Contains(got, "import.meta") {
		t.Errorf("import.meta.hot should pass through unchanged: %s", got)
	}
}

// ── WrapStaticImport ─────────────────────────────────────────────────────────
//
// ES-module entry points use static `import … from "…"` to load chunks.
// When served through the proxy the relative specifiers resolve against the
// proxy goto= URL, landing on the proxy origin without the correct path.
// Rewriting them to proxified absolute URLs at rewrite time fixes chunk loading
// for Gatsby, Vite, and webpack 5 module bundles.

func TestWrapStaticImport_RelativeSpecifier_Proxified(t *testing.T) {
	base := mustParseURL("https://cdn.example.com/runtime/browser-entry.js")
	opts := DefaultOptions()
	opts.BaseURL = base
	opts.ProxifyURL = staticProxify

	got := rewriteWith(t, `import { a } from "./chunks/chunk-X.js";`, opts)
	want := `"https://proxy.example.com/cyrano/https/cdn.example.com/runtime/chunks/chunk-X.js"`
	if !strings.Contains(got, want) {
		t.Errorf("static import specifier not proxified: %s", got)
	}
}

func TestWrapStaticImport_ExportFrom_Proxified(t *testing.T) {
	base := mustParseURL("https://cdn.example.com/runtime/entry.js")
	opts := DefaultOptions()
	opts.BaseURL = base
	opts.ProxifyURL = staticProxify

	got := rewriteWith(t, `export { a } from "./utils.js";`, opts)
	want := `"https://proxy.example.com/cyrano/https/cdn.example.com/runtime/utils.js"`
	if !strings.Contains(got, want) {
		t.Errorf("static re-export specifier not proxified: %s", got)
	}
}

func TestWrapStaticImport_AbsoluteURL_Proxified(t *testing.T) {
	// Absolute URLs (e.g. CDN imports) are proxified the same way as relative ones.
	base := mustParseURL("https://cdn.example.com/app.js")
	opts := DefaultOptions()
	opts.BaseURL = base
	opts.ProxifyURL = staticProxify

	got := rewriteWith(t, `import lib from "https://other.example.com/lib.js";`, opts)
	want := `"https://proxy.example.com/cyrano/https/other.example.com/lib.js"`
	if !strings.Contains(got, want) {
		t.Errorf("absolute URL specifier not proxified: %s", got)
	}
}

func TestWrapStaticImport_FlagOff_PassesThrough(t *testing.T) {
	base := mustParseURL("https://cdn.example.com/entry.js")
	opts := DefaultOptions()
	opts.BaseURL = base
	opts.ProxifyURL = staticProxify
	opts.WrapStaticImport = false

	got := rewriteWith(t, `import { a } from "./chunk.js";`, opts)
	if strings.Contains(got, "proxy.example.com/cyrano/") {
		t.Errorf("WrapStaticImport=false: specifier should not be proxified: %s", got)
	}
}

func TestWrapStaticImport_NoBaseURL_PassesThrough(t *testing.T) {
	opts := DefaultOptions()
	// BaseURL intentionally omitted.

	got := rewriteWith(t, `import { a } from "./chunk.js";`, opts)
	if strings.Contains(got, "proxy.example.com/cyrano/") {
		t.Errorf("no BaseURL: specifier should not be proxified: %s", got)
	}
}

// ── Static-import fallback (parse-failure path) ─────────────────────────────
//
// When tdewolff fails to parse a module (e.g. due to a syntax it doesn't
// recognise), Rewrite falls back to a simple byte-scan that still rewrites
// the `from "…"` specifiers in the leading import block.

func staticProxifyFallback(raw string, base *url.URL) string {
	abs, err := base.Parse(raw)
	if err != nil || (abs.Scheme != "http" && abs.Scheme != "https") {
		return raw
	}
	escapedPath := abs.EscapedPath()
	if escapedPath == "" {
		escapedPath = "/"
	}
	return "http://proxy.example.com/cyrano/" + abs.Scheme + "/" + abs.Host + escapedPath
}

func TestRewriteImportSpecifiersFallback_RelativeSpecifier(t *testing.T) {
	base, _ := url.Parse("https://cdn.example.com/runtime/chunks/chunk-A.js")
	opts := Options{
		WrapStaticImport: true,
		BaseURL:          base,
		ProxifyURL:       staticProxifyFallback,
	}
	// Simulate a module that fails AST parse: pass raw bytes with
	// unparseable syntax that still has a leading import.
	src := `import { a } from "./chunk-B.js";` + "\n" + `var f=([x]=[0])=>{return x;};`
	got := rewriteImportSpecifiersFallback([]byte(src), opts)
	result := string(got)
	if !strings.Contains(result, "proxy.example.com") {
		t.Errorf("specifier not proxified in fallback: %s", result)
	}
	if strings.Contains(result, `"./chunk-B.js"`) {
		t.Errorf("original specifier still present: %s", result)
	}
}

func TestRewriteImportSpecifiersFallback_SideEffectImport(t *testing.T) {
	base, _ := url.Parse("https://cdn.example.com/runtime/chunks/chunk-A.js")
	opts := Options{
		WrapStaticImport: true,
		BaseURL:          base,
		ProxifyURL:       staticProxifyFallback,
	}
	src := `import "./chunk-B.js";` + "\n" + `var f=([x]=[0])=>{};`
	got := rewriteImportSpecifiersFallback([]byte(src), opts)
	result := string(got)
	if !strings.Contains(result, "proxy.example.com") {
		t.Errorf("side-effect import not proxified in fallback: %s", result)
	}
}

func TestRewriteImportSpecifiersFallback_StopsAtNonImport(t *testing.T) {
	base, _ := url.Parse("https://cdn.example.com/runtime/chunks/chunk-A.js")
	opts := Options{
		WrapStaticImport: true,
		BaseURL:          base,
		ProxifyURL:       staticProxifyFallback,
	}
	// The `from "./chunk-B.js"` inside a string literal after real code must
	// NOT be proxified — the scanner stops at the first non-import statement.
	src := `import { a } from "./chunk-A.js";` + "\n" +
		`var x = 1; // from "./chunk-B.js" inside non-import`
	got := rewriteImportSpecifiersFallback([]byte(src), opts)
	result := string(got)
	// chunk-B is in a comment after real code — must NOT be proxified.
	if strings.Contains(result, "proxy.example.com/cyrano/") && strings.Contains(result, "chunk-B") {
		// If both appear, make sure they're not on the same token.
		if strings.Contains(result, "proxy.example.com/cyrano/https/cdn.example.com/runtime/chunks/chunk-B") {
			t.Errorf("scanner rewrote chunk-B beyond import block: %s", result)
		}
	}
	// The real import of chunk-A should be rewritten.
	if !strings.Contains(result, "proxy.example.com/cyrano/https/cdn.example.com/runtime/chunks/chunk-A") {
		t.Errorf("real import not rewritten: %s", result)
	}
}

// ── WRAP_NEW_WORKER ─────────────────────────────────────────────────────────

func TestWrapNewWorker_PlainWorker(t *testing.T) {
	got := rewrite(t, `var w = new Worker("https://example.com/worker.js");`)
	if !strings.Contains(got, `$rewriter.wrap_worker_url(`) {
		t.Errorf("wrap_worker_url not injected: %s", got)
	}
	if !strings.Contains(got, `"https://example.com/worker.js"`) {
		t.Errorf("original url string not preserved inside wrap call: %s", got)
	}
}

func TestWrapNewWorker_SharedWorker(t *testing.T) {
	got := rewrite(t, `var sw = new SharedWorker("https://example.com/sw.js", "name");`)
	if !strings.Contains(got, `$rewriter.wrap_worker_url(`) {
		t.Errorf("wrap_worker_url not injected for SharedWorker: %s", got)
	}
}

func TestWrapNewWorker_WithVariable(t *testing.T) {
	got := rewrite(t, `var w = new Worker(workerUrl);`)
	if !strings.Contains(got, `$rewriter.wrap_worker_url(workerUrl)`) {
		t.Errorf("wrap_worker_url not injected for variable url: %s", got)
	}
}

func TestWrapNewWorker_Disabled(t *testing.T) {
	got := rewriteWith(t, `new Worker("https://x.com/w.js");`, Options{WrapNewWorker: false})
	if strings.Contains(got, `wrap_worker_url`) {
		t.Errorf("wrap_worker_url injected when rule disabled: %s", got)
	}
}


func TestRewrite_StripsDebuggerStatements(t *testing.T) {
	in := `function f(){debugger;var x=1;if(x){debugger}return x;}`
	out := string(Rewrite([]byte(in), DefaultOptions()))
	if strings.Contains(out, "debugger") {
		t.Errorf("debugger statement not stripped: %s", out)
	}
	if !strings.Contains(out, "var x") || !strings.Contains(out, "return x") {
		t.Errorf("stripping debugger corrupted surrounding code: %s", out)
	}
}

func TestRewrite_PreservesOptionalChainOnComputedAccess(t *testing.T) {
	opts := DefaultOptions()
	opts.WrapMemberExpression = true
	// n?.routes[k] must NOT become wrap_member_expression(n?.routes,k)[k], which
	// throws when n is nullish instead of short-circuiting (TanStack Router bug).
	out := string(Rewrite([]byte(`function f(n,k){return n?.routes[k];}`), opts))
	if strings.Contains(out, "wrap_member_expression(n?.routes") ||
		strings.Contains(out, "wrap_member_expression(n == null") {
		t.Errorf("optional-chain object was wrapped (breaks short-circuit): %s", out)
	}
	if !strings.Contains(out, "?.") {
		t.Errorf("optional chaining lost entirely: %s", out)
	}
	// Plain computed access on a non-optional object is still wrapped.
	out2 := string(Rewrite([]byte(`function g(o,k){return o[k];}`), opts))
	if !strings.Contains(out2, "wrap_member_expression") {
		t.Errorf("non-optional computed access should still be wrapped: %s", out2)
	}
}
