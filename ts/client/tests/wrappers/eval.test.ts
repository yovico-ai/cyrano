// @vitest-environment node
//
// Eval wrappers now actually rewrite their JS-source argument through the
// client-side JS rewriter. The previous version of these tests pinned
// passthrough semantics; the changes here document the contract switch.

import { describe, expect, it } from "vitest";
import {
    wrapEval,
    wrapEvalArg,
    wrapEvalMemexp,
} from "../../src/wrappers/eval";

describe("wrapEvalArg — rewrites JS source", () => {
    it("injects wrap_get_location around bare `location`", () => {
        const src = "var x = location;";
        // eslint-disable-next-line no-eval
        const got = wrapEvalArg(eval, src) as string;
        expect(got).toContain("$rewriter.wrap_get_location(location)");
    });

    it("injects wrap_set_location around `location = X`", () => {
        const src = "location = 'http://x';";
        // eslint-disable-next-line no-eval
        const got = wrapEvalArg(eval, src) as string;
        expect(got).toContain("$rewriter.wrap_set_location");
    });

    it("non-string argument passes through unchanged", () => {
        // eslint-disable-next-line no-eval
        const got = wrapEvalArg(eval, 42);
        expect(got).toBe(42);
    });

    it("already-rewritten input is not double-wrapped", () => {
        const src = "$rewriter.wrap_get_location(location);";
        // eslint-disable-next-line no-eval
        const got = wrapEvalArg(eval, src) as string;
        // The preamble is prepended for eval-context accessibility but the
        // original call must appear unchanged (no double-wrapping).
        expect(got).toContain(src);
        expect(got).not.toContain("$rewriter.wrap_get_location($rewriter");
    });
});

describe("wrapEval — returns a wrapping eval-like function", () => {
    it("the returned function rewrites its first arg before calling eval", () => {
        // We can't actually run eval in a test (would attempt to invoke
        // wrap_get_location on the live `location`); inspect the rewriter
        // by intercepting the inner eval through a fake.
        const fakeEval = ((src: unknown) => src) as typeof eval;
        const wrapped = wrapEval(fakeEval);
        const result = wrapped("var x = location;") as string;
        expect(result).toContain("$rewriter.wrap_get_location(location)");
    });

    it("non-string source passes through to native eval verbatim", () => {
        const fakeEval = ((src: unknown) => src) as typeof eval;
        const wrapped = wrapEval(fakeEval);
        expect(wrapped(42 as unknown as string)).toBe(42);
    });
});

describe("wrapEvalMemexp — proxy that intercepts .eval", () => {
    it("forwards non-eval property reads to the underlying object", () => {
        const obj = { foo: 42, bar: "hello", eval: () => 0 };
        const wrapped = wrapEvalMemexp(obj) as { foo: number; bar: string };
        expect(wrapped.foo).toBe(42);
        expect(wrapped.bar).toBe("hello");
    });

    it("rewrites the first string arg of .eval before delegating", () => {
        let received: string | undefined;
        const obj = {
            eval: function(src: unknown) { received = src as string; return src; },
        };
        const wrapped = wrapEvalMemexp(obj) as { eval: (s: string) => unknown };
        wrapped.eval("var x = location;");
        expect(received).toContain("$rewriter.wrap_get_location(location)");
    });

    it("preserves trailing args and `this` semantics for .eval", () => {
        let receivedThis: unknown;
        let receivedArgs: unknown[] = [];
        const obj = {
            marker: "obj",
            eval: function(this: unknown, ...args: unknown[]) {
                receivedThis = this;
                receivedArgs = args;
            },
        };
        const wrapped = wrapEvalMemexp(obj) as { eval: (...args: unknown[]) => unknown };
        wrapped.eval("var x = 1;", "extra1", 2);
        // `this` inside the call should be the underlying obj, not the proxy.
        expect((receivedThis as { marker: string }).marker).toBe("obj");
        // Trailing args pass through verbatim.
        expect(receivedArgs[1]).toBe("extra1");
        expect(receivedArgs[2]).toBe(2);
    });

    it("non-string first arg passes through to .eval verbatim", () => {
        let received: unknown;
        const obj = { eval: function(src: unknown) { received = src; } };
        const wrapped = wrapEvalMemexp(obj) as { eval: (s: unknown) => unknown };
        wrapped.eval(42 as unknown as string);
        expect(received).toBe(42);
    });

    it("primitives are returned unchanged (Proxy can't wrap them)", () => {
        expect(wrapEvalMemexp(null)).toBeNull();
        expect(wrapEvalMemexp(undefined)).toBeUndefined();
        expect(wrapEvalMemexp(42)).toBe(42);
        expect(wrapEvalMemexp("str")).toBe("str");
    });

    it("forwards .eval that isn't a function (e.g. property holding a string)", () => {
        const obj = { eval: "not a function" };
        const wrapped = wrapEvalMemexp(obj) as { eval: string };
        expect(wrapped.eval).toBe("not a function");
    });
});
