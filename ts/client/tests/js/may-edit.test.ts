// mayEdit (src/js/rewriter.ts): the exit that spares the parser. It must
// say yes for every source a rule edits — each shared case that changes —
// and a source it refuses is given back without a parse.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Parser } from "acorn";

import { defaultJsRewriteOptions, mayEdit, rewriteJsSource } from "../../src/js/rewriter";

const cases = JSON.parse(readFileSync(resolve(__dirname, "../../../../spec/js-rewrite/cases.json"), "utf8")) as Array<[string, string, string]>;

describe("mayEdit", () => {
    it("is true for every shared case a rule edits", () => {
        const missed = cases.filter(([, src, want]) => src !== want && !mayEdit(src)).map(([name]) => name);
        expect(missed).toEqual([]);
        expect(cases.filter(([, src, want]) => src !== want).length).toBeGreaterThan(30);
    });

    it("a source no rule can touch is not parsed: Turnstile's timing probe", () => {
        const probe = " ".repeat(1_337_331) + "0, /.*honk.*/, 1795223596708";
        expect(mayEdit(probe)).toBe(false);
        const parse = vi.spyOn(Parser, "parse");
        const t = performance.now();
        expect(rewriteJsSource(probe, defaultJsRewriteOptions())).toBe(probe);
        expect(parse).not.toHaveBeenCalled();
        expect(performance.now() - t).toBeLessThan(50);
        parse.mockRestore();
    });

    it("an escape may spell a name: parsed", () => {
        for (const src of ["x[k]", "a.\\u006cocation", 'a["\\x74op"]', "t\\u006fp", "location", "f(top)", "w.parent", "eval(s)", "d.write(h)", "w.postMessage(m)", 'import("m")', 'export * from "m"', "new Worker(u)", "debugger;"]) {
            expect(mayEdit(src), src).toBe(true);
        }
        for (const src of ["var a = b + c;", "f(1, 2); g.h.i = j;", "0, /.*honk.*/, 1", "x => x * 2"]) {
            expect(mayEdit(src), src).toBe(false);
            expect(rewriteJsSource(src, defaultJsRewriteOptions())).toBe(src);
        }
    });
});
