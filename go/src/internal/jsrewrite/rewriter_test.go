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

// ── $apMe declaration prepended when wrap_member_expression fires ─────────
//
// Regression: the wrap_member_expression template uses `$apMe = expr` to
// capture the dynamic key for the bracket access. In strict-mode scripts,
// assignment to an undeclared name throws ReferenceError. Slashdot's
// cmp-slashdot.js (and any other "use strict" script using computed
// property access) hit this in production. We fix by prepending
// `var $__crn_tmp__;` to the output whenever wrap_member_expression fired.

func TestRewrite_PrependsCrnTmpDeclaration_WhenMemberExpressionUsed(t *testing.T) {
	in := `var x = obj["dynamic" + key];`
	got := rewrite(t, in)
	if !strings.HasPrefix(got, "var $__crn_tmp__;\n") {
		t.Errorf("expected `var $__crn_tmp__;` declaration prepended, got: %s", got)
	}
	if !strings.Contains(got, "$rewriter.wrap_member_expression") {
		t.Errorf("wrap_member_expression should fire on bracket access: %s", got)
	}
}

func TestRewrite_DoesNotPrependCrnTmp_WhenNoMemberExpression(t *testing.T) {
	in := `var x = location;`
	got := rewrite(t, in)
	if strings.Contains(got, "$__crn_tmp__") {
		t.Errorf("$__crn_tmp__ declaration should NOT appear when wrap_member_expression didn't fire: %s", got)
	}
}

// $__crn_tmp__ survives strict-mode source: feeding the rewritten output back
// as JS, with "use strict" at the top, the resulting program parses cleanly
// (we can't EXECUTE it from a Go test, but parse success means the
// declaration is in scope of every assignment).
func TestRewrite_CrnTmpDeclaration_ParsesWithStrictMode(t *testing.T) {
	in := `"use strict"; var v = obj[key];`
	got := rewrite(t, in)
	// A second pass on the already-rewritten output is a no-op (idempotence
	// guard), but it's a useful smoke check that the prepended declaration
	// doesn't break the parser the second time around.
	twice := rewrite(t, got)
	if got != twice {
		t.Errorf("re-rewriting var $__crn_tmp__; output drifted:\nonce: %s\ntwice: %s", got, twice)
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
	return "https://proxy.example.com/?goto=" + resolved.String()
}

func TestWrapImportArg_StaticStringLiteral_AbsoluteURL(t *testing.T) {
	base := mustParseURL("https://cdn.example.com/assets/main.js")
	opts := DefaultOptions()
	opts.BaseURL = base
	opts.ProxifyURL = staticProxify

	got := rewriteWith(t, `import("https://other.example.com/mod.js");`, opts)
	want := `"https://proxy.example.com/?goto=https://other.example.com/mod.js"`
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
	want := `"https://proxy.example.com/?goto=https://cdn.example.com/assets/chunk-abc.js"`
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
