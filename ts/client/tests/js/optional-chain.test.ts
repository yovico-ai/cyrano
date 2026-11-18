// A wrapped member access inside an optional chain short-circuits as the
// native does (ibm.com: `digitalData?.user?.location?.country` with no
// user threw "Cannot read properties of undefined (reading 'location')").

import { describe, expect, it } from "vitest";
import { defaultJsRewriteOptions, rewriteJsSource } from "../../src/js/rewriter";
import { honourOptionalChains } from "../../src/runtime/optional";

function run(src: string, scope: Record<string, unknown>): unknown {
    const out = rewriteJsSource(`result = (${src});`, defaultJsRewriteOptions());
    // The helpers as the runtime has them: a nullish obj is the native TypeError.
    const $rewriter = honourOptionalChains({
        wrap_location: (a: { obj: { location: unknown } }) => ({ get location() { return a.obj.location; } }),
        wrap_top_window: (a: { obj: { top: unknown } }) => ({ get top() { return a.obj.top; } }),
        wrap_parent_window: (a: { obj: { parent: unknown } }) => ({ get parent() { return a.obj.parent; } }),
    });
    const env: Record<string, unknown> = { ...scope, result: "unset" };
    const g = globalThis as Record<string, unknown>;
    g["$rewriter"] = $rewriter; // the rewriter's preamble takes it from the global
    try {
        new Function("env", `with (env) { ${out} }`)(env);
    } finally {
        delete g["$rewriter"];
    }
    return env["result"];
}

describe("wrapped members in optional chains", () => {
    const data = { user: { location: { country: "us" }, top: { x: 1 } } };
    it.each([
        ["d?.user?.location?.country", { d: data }, "us"],
        ["d?.user?.location?.country", { d: {} }, undefined],
        ["d?.user?.location?.country", { d: undefined }, undefined],
        ["d?.user.location.country", { d: undefined }, undefined],
        ["d?.user?.top?.x", { d: {} }, undefined],
        ["d?.user?.parent?.x", { d: {} }, undefined],
        ["d.user.location.country", { d: data }, "us"],
    ])("%s", (src, scope, want) => {
        expect(run(src, scope as Record<string, unknown>)).toBe(want);
    });
    it("outside a chain the native TypeError still comes", () => {
        expect(() => run("d.user.location.country", { d: {} })).toThrow(TypeError);
    });
});
