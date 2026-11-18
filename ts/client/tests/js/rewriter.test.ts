// The JS rewriting rules (R1…R11 in src/js/rewriter.ts), as edits spliced
// into the page's own text. For each case: the code that runs (markers
// removed), and three invariants — the original comes back byte for byte,
// the output parses, and no line is added.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultJsRewriteOptions, rewriteJsSource } from "../../src/js/rewriter";
import { original, unmarked } from "../../src/js/marks";

const all = defaultJsRewriteOptions();

/** The rewritten code as it runs, without the preamble. */
function code(out: string): string {
    return unmarked(out).replace(/var \$rewriter=globalThis.*?\$__crn_key__\|\|0;/, "");
}

// The cases are shared with the Go rewriter (spec/js-rewrite/cases.json):
// [rule, source, the code that must run].
const cases = JSON.parse(readFileSync(resolve(__dirname, "../../../../spec/js-rewrite/cases.json"), "utf8")) as Array<[string, string, string]>;


describe("JS rewriting rules", () => {
    it.each(cases)("%s: %s", (_rule, src, want) => {
        const out = rewriteJsSource(src, all);
        expect(code(out)).toBe(want);
        expect(original(out)).toBe(src);
        expect(out.split("\n").length).toBe(src.split("\n").length);
        expect(() => new Function(out.replace(/\bimport\(/g, "imp("))).not.toThrow();
    });

    it("keeps the page's own formatting and comments, byte for byte", () => {
        const src = "function f ( a,b ){\n  // a comment\n  return a  +  b /* odd   spacing */ ;\n}\nx = f(1,2) , location.href";
        const out = rewriteJsSource(src, all);
        expect(original(out)).toBe(src);
        expect(code(out)).toBe(src.replace("location", "$rewriter.wrap_get_location(location)"));
    });

    it("the preamble goes after a leading use-strict directive, and adds no line", () => {
        const out = rewriteJsSource('"use strict";\nx = top;', all);
        expect(unmarked(out)).toMatch(/^"use strict";var \$rewriter=/);
        expect(out.split("\n").length).toBe(2);
        expect(original(out)).toBe('"use strict";\nx = top;');
    });

    it("module specifiers and import.meta.url, with the script's URL", () => {
        const o = { ...all, baseUrl: "https://cdn.example/app/main.js", proxify: (s: string, b: string) => (/^\.{0,2}\//.test(s) ? "P:" + new URL(s, b).href : s) };
        const src = 'import a from "./a.js"; import "react"; export * from "../b.js"; x = import.meta.url; import("./c.js"); import(v);';
        const out = rewriteJsSource(src, o);
        expect(code(out)).toBe('import a from "P:https://cdn.example/app/a.js"; import "react"; export * from "P:https://cdn.example/b.js"; ' +
            'x = "https://cdn.example/app/main.js"; import("P:https://cdn.example/app/c.js"); import($rewriter.wrap_import_arg(v,"https://cdn.example/app/main.js"));');
        expect(original(out)).toBe(src);
    });

    it("a function's own source is recoverable from what the engine reports", () => {
        const src = "function f(a) { return a[location.hash] }";
        const out = rewriteJsSource(src, all);
        const f = new Function(out + "; return f;")() as () => unknown;
        expect(original(Function.prototype.toString.call(f))).toBe(src);
        // An arrow function's expression body: the closing marker falls outside its source.
        const arrow = new Function("return " + rewriteJsSource("x => x[top]", all).replace(/^.*?\|\|0;\/\*\x7f\*\//, ""))() as () => unknown;
        expect(original(Function.prototype.toString.call(arrow))).toBe("x => x[top]");
    });

    it("leaves alone what does not parse, what is already rewritten, and what is empty", () => {
        expect(rewriteJsSource("this is not js (", all)).toBe("this is not js (");
        const already = "var x = $rewriter.wrap_get_location(location);";
        expect(unmarked(rewriteJsSource(already, all))).toContain(already);
        expect(rewriteJsSource("", all)).toBe("");
        expect(rewriteJsSource("var a = 1;", all)).toBe("var a = 1;");
    });

    it("the marker character alone in a script's own strings does not prevent marking", () => {
        const src = "var s = 'a\x7fb*\x7f'; function f(o, k) { return o[k] + top }";
        expect(original(rewriteJsSource(src, all))).toBe(src);
    });

    it("a script holding what reads as a marker is rewritten without markers", () => {
        const src = "x = '/*\x7f'; y = top;";
        expect(rewriteJsSource(src, all)).toContain("y = $rewriter.wrap_get_top_window(top);");
        // … and then nothing separates an insertion from a keyword before it.
        expect(rewriteJsSource("x = '/*\x7f'; function f(a, k) { return[a][k] }", all))
            .toContain("return $rewriter.wrap_member_expression([a],$__crn_key__=(k))[$__crn_key__]");
    });
});
