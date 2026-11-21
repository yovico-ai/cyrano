// A source rewritten again is not parsed again (src/js/rewriter.ts): the
// result is the same string, for the same options only, and a module's
// (whose result depends on its URL) is never kept.
import { describe, expect, it, vi } from "vitest";
import { Parser } from "acorn";

import { defaultJsRewriteOptions, rewriteJsSource } from "../../src/js/rewriter";

const big = (tag: string): string => `var tag = ${JSON.stringify(tag)};\n` + "function f(o, k) { return o[k] + window.location.href; }\n".repeat(120);

describe("rewriteJsSource memo", () => {
    it("parses a repeated source once, and gives the same result", () => {
        const src = big("once");
        const parse = vi.spyOn(Parser, "parse");
        const first = rewriteJsSource(src, defaultJsRewriteOptions());
        const calls = parse.mock.calls.length;
        expect(calls).toBeGreaterThan(0);
        for (let i = 0; i < 5; i++) expect(rewriteJsSource(src + "", defaultJsRewriteOptions())).toBe(first);
        expect(parse.mock.calls.length).toBe(calls);
        expect(first).toContain("$rewriter.wrap_member_expression");
        parse.mockRestore();
    });

    it("keeps results apart by options", () => {
        const src = big("options");
        const all = rewriteJsSource(src, defaultJsRewriteOptions());
        const noR5 = rewriteJsSource(src, { ...defaultJsRewriteOptions(), wrapMemberExpression: false });
        expect(noR5).not.toContain("wrap_member_expression");
        expect(rewriteJsSource(src, defaultJsRewriteOptions())).toBe(all);
        expect(all).toContain("wrap_member_expression");
    });

    it("does not keep a module's rewriting: it depends on the module's URL", () => {
        const src = `import x from "./dep.js";\n` + big("module");
        const at = (base: string): string => rewriteJsSource(src, { ...defaultJsRewriteOptions(), baseUrl: base, proxify: (s, b) => new URL(s, b).href });
        expect(at("https://a.example/m/one.js")).toContain("https://a.example/m/dep.js");
        expect(at("https://b.example/n/two.js")).toContain("https://b.example/n/dep.js");
    });

    it("a source that does not parse is given back each time", () => {
        const src = "function ( {" + " ".repeat(5000);
        expect(rewriteJsSource(src, defaultJsRewriteOptions())).toBe(src);
        expect(rewriteJsSource(src, defaultJsRewriteOptions())).toBe(src);
    });
});
