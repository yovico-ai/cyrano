// @vitest-environment node
//
// JS rewriter parity tests. Mirrors go/src/internal/jsrewrite/rewriter_test.go
// — the same input must produce semantically equivalent output (the wrapped
// runtime call shapes the server emits).
//
// Note: astring's serialization differs from tdewolff's in cosmetic ways
// (whitespace, line breaks around object literals, parens). Tests assert on
// pattern presence rather than exact bytes — what matters is that the right
// wrap_* calls appear in the right positions, not the formatting.

import { describe, expect, it } from "vitest";
import { defaultJsRewriteOptions, rewriteJsSource } from "../../src/js/rewriter";

const all = defaultJsRewriteOptions();

/** Collapse all whitespace runs to a single space, for format-tolerant comparison. */
function squash(s: string): string {
    return s.replace(/\s+/g, " ").trim();
}

describe("rewriteJsSource — already-rewritten input is left alone", () => {
    it("skips input containing $rewriter.wrap_", () => {
        const src = "$rewriter.wrap_get_location(location);";
        expect(rewriteJsSource(src, all)).toBe(src);
    });

    it("skips input containing $rewriter_init(", () => {
        const src = "$rewriter_init(window, cfg);";
        expect(rewriteJsSource(src, all)).toBe(src);
    });
});

describe("rewriteJsSource — fail-open on parse error", () => {
    it("returns the source unchanged when parsing fails", () => {
        const src = "this is not (valid (((";
        expect(rewriteJsSource(src, all)).toBe(src);
    });

    it("empty input passes through", () => {
        expect(rewriteJsSource("", all)).toBe("");
    });
});

describe("rewriteJsSource — bare identifiers (rvalue)", () => {
    it("wraps `location` rvalue in wrap_get_location", () => {
        const got = rewriteJsSource("var x = location;", all);
        expect(got).toContain("$rewriter.wrap_get_location(location)");
    });

    it("wraps `top` rvalue in wrap_get_top_window", () => {
        const got = rewriteJsSource("var t = top;", all);
        expect(got).toContain("$rewriter.wrap_get_top_window(top)");
    });

    it("wraps `parent` rvalue in wrap_get_top_window (v1 reuses the same helper)", () => {
        const got = rewriteJsSource("var p = parent;", all);
        expect(got).toContain("$rewriter.wrap_get_top_window(parent)");
    });

    it("wraps `eval` rvalue in wrap_eval", () => {
        const got = rewriteJsSource("var f = eval;", all);
        expect(got).toContain("$rewriter.wrap_eval(eval)");
    });
});

describe("rewriteJsSource — `location = X` (set_location)", () => {
    it("rewrites bare assignment to location", () => {
        const got = rewriteJsSource("location = 'http://x';", all);
        expect(got).toContain("$rewriter.wrap_set_location(location");
        expect(got).toMatch(/\.value\s*=\s*['"]http:\/\/x['"]/);
    });

    it("`location = location` rewrites both sides — set on LHS, get on RHS", () => {
        const got = rewriteJsSource("location = location;", all);
        expect(got).toContain("$rewriter.wrap_set_location");
        expect(got).toContain("$rewriter.wrap_get_location(location)");
    });
});

describe("rewriteJsSource — `obj.X` member-access wrapping", () => {
    it("wraps obj.location with wrap_location", () => {
        const got = squash(rewriteJsSource("var x = window.location;", all));
        expect(got).toContain("$rewriter.wrap_location({ obj: window }).location");
    });

    it("wraps obj.top with wrap_top_window", () => {
        const got = squash(rewriteJsSource("var t = window.top;", all));
        expect(got).toContain("$rewriter.wrap_top_window({ obj: window }).top");
    });

    it("wraps obj.parent with wrap_parent_window", () => {
        const got = squash(rewriteJsSource("var p = window.parent;", all));
        expect(got).toContain("$rewriter.wrap_parent_window({ obj: window }).parent");
    });

    it("wraps doc.write with wrap_document_write", () => {
        const got = squash(rewriteJsSource("document.write('<p>x</p>');", all));
        expect(got).toContain("$rewriter.wrap_document_write({ obj: document }).write(");
    });

    it("wraps doc.writeln with wrap_document_write", () => {
        const got = squash(rewriteJsSource("document.writeln('x');", all));
        expect(got).toContain("$rewriter.wrap_document_write({ obj: document }).writeln(");
    });

    it("wraps obj.postMessage with wrap_postMessage", () => {
        const got = squash(rewriteJsSource("window.postMessage(msg, '*');", all));
        expect(got).toContain("$rewriter.wrap_postMessage({ obj: window }).postMessage(");
    });

    it("wraps obj.eval with wrap_eval_memexp", () => {
        const got = squash(rewriteJsSource("window.eval('1+1');", all));
        expect(got).toContain("$rewriter.wrap_eval_memexp(window).eval(");
    });
});

describe("rewriteJsSource — eval call argument wrapping", () => {
    it("wraps the first argument of bare eval(...)", () => {
        const got = rewriteJsSource("eval('var x = 1;');", all);
        expect(got).toContain("$rewriter.wrap_eval_arg(eval, 'var x = 1;')");
        // Must NOT also wrap eval as a value (would produce
        // $rewriter.wrap_eval_arg($rewriter.wrap_eval(eval), ...)).
        expect(got).not.toContain("wrap_eval_arg($rewriter.wrap_eval");
    });

    it("preserves trailing args in eval(arg, ...)", () => {
        const got = rewriteJsSource("eval('x', 'y', 'z');", all);
        expect(got).toContain("$rewriter.wrap_eval_arg(eval, 'x')");
        expect(got).toContain("'y'");
        expect(got).toContain("'z'");
    });
});

describe("rewriteJsSource — computed member expressions", () => {
    it("wraps obj[expr] with wrap_member_expression", () => {
        const got = rewriteJsSource("var x = obj['locat' + 'ion'];", all);
        expect(got).toContain("$rewriter.wrap_member_expression(obj");
        expect(got).toContain("$apMe");
    });
});

describe("rewriteJsSource — recursive descent", () => {
    it("rewrites inside if/else", () => {
        const got = rewriteJsSource("if (location) { var x = top; }", all);
        expect(got).toContain("$rewriter.wrap_get_location(location)");
        expect(got).toContain("$rewriter.wrap_get_top_window(top)");
    });

    it("rewrites inside function body", () => {
        const got = rewriteJsSource("function f() { return location; }", all);
        expect(got).toContain("$rewriter.wrap_get_location(location)");
    });

    it("rewrites inside arrow function body", () => {
        const got = rewriteJsSource("var f = () => location;", all);
        expect(got).toContain("$rewriter.wrap_get_location(location)");
    });

    it("rewrites inside template literal expressions", () => {
        const got = rewriteJsSource("`prefix-${location}-suffix`;", all);
        expect(got).toContain("$rewriter.wrap_get_location(location)");
    });

    it("rewrites inside conditional / ternary", () => {
        const got = rewriteJsSource("var x = a ? location : top;", all);
        expect(got).toContain("$rewriter.wrap_get_location(location)");
        expect(got).toContain("$rewriter.wrap_get_top_window(top)");
    });

    it("rewrites inside try/catch", () => {
        const got = rewriteJsSource("try { var x = location; } catch(e) {}", all);
        expect(got).toContain("$rewriter.wrap_get_location(location)");
    });

    it("rewrites inside for loops", () => {
        const got = rewriteJsSource("for (var i = 0; i < 1; i++) { var x = location; }", all);
        expect(got).toContain("$rewriter.wrap_get_location(location)");
    });
});

describe("rewriteJsSource — selective rule disabling", () => {
    it("only the enabled rules fire", () => {
        const opts = { ...defaultJsRewriteOptions(), wrapLocation: false };
        const got = rewriteJsSource("var x = window.location;", opts);
        // wrap_location disabled → should NOT wrap
        expect(got).not.toContain("$rewriter.wrap_location");
        // window.location is still in the source unchanged
        expect(got).toContain("window.location");
    });

    it("a rule turned off mid-set leaves matching nodes untouched", () => {
        const opts = { ...defaultJsRewriteOptions(), wrapGetLocation: false };
        const got = rewriteJsSource("var x = location;", opts);
        expect(got).not.toContain("wrap_get_location");
        expect(got).toContain("location");
    });
});

describe("rewriteJsSource — non-rewrite cases", () => {
    it("local `var location = ...` is still rewritten on the rvalue side", () => {
        // Note: server rewriter doesn't track scopes either. Bare `location`
        // name matches always. Documented behavior, parity with server.
        const got = rewriteJsSource("var location = 1;", all);
        // Init expression `1` doesn't reference location, so no wrap fires.
        expect(got).toContain("var location = 1");
    });

    it("plain code without any hooked identifiers passes through unchanged-ish", () => {
        const got = rewriteJsSource("var x = a + b;", all);
        expect(got).not.toContain("wrap_");
    });
});
