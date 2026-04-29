// @vitest-environment node
//
// patchFunctionConstructor mutates the global `Function`. Since we can't
// safely undo that without breaking other tests, this test file installs
// the patch once and asserts behavior. Other test files that don't use
// `Function` are unaffected.

import { describe, expect, it } from "vitest";
import { patchFunctionConstructor } from "../../src/patches/function-ctor";

describe("patchFunctionConstructor", () => {
    it("rewrites the body argument when constructed via new Function(body)", () => {
        patchFunctionConstructor(globalThis as unknown as Window);
        // new Function("body") — single arg is the body.
        const fn = new Function("var x = location; return x;") as Function;
        // Reading fn.toString() lets us see what the engine compiled. The
        // body should now contain wrap_get_location.
        expect(fn.toString()).toContain("$rewriter.wrap_get_location(location)");
    });

    it("rewrites only the LAST string argument (preceding args are param names)", () => {
        patchFunctionConstructor(globalThis as unknown as Window);
        const fn = new Function("a", "b", "return location;") as Function;
        const src = fn.toString();
        expect(src).toContain("$rewriter.wrap_get_location(location)");
        // Param names are unchanged. Format varies by engine
        // (`(a, b)` vs `(a,b)`); assert by collapsing whitespace.
        expect(src.replace(/\s+/g, "")).toContain("(a,b)");
    });

    it("works when called without `new`", () => {
        patchFunctionConstructor(globalThis as unknown as Window);
        // Function(body) without `new` is equivalent to new Function(body).
        const fn = (Function as unknown as (body: string) => Function)(
            "var x = location;",
        );
        expect(fn.toString()).toContain("$rewriter.wrap_get_location(location)");
    });

    it("non-string body passes through (engine throws or ignores natively)", () => {
        patchFunctionConstructor(globalThis as unknown as Window);
        // Engines coerce non-strings; we don't pre-rewrite them. Just assert
        // we don't break the construction.
        expect(() => new Function(undefined as unknown as string)).not.toThrow();
    });

    it("zero-arg call returns a function with empty body", () => {
        patchFunctionConstructor(globalThis as unknown as Window);
        // new Function() returns the equivalent of `function anonymous() {}`.
        const fn = new Function() as Function;
        expect(typeof fn).toBe("function");
    });

    it("instances are still instanceof Function", () => {
        patchFunctionConstructor(globalThis as unknown as Window);
        const fn = new Function("return 1;") as Function;
        expect(fn instanceof Function).toBe(true);
    });
});
