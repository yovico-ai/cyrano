// Patches the global Function constructor.
//
// `new Function(arg1, arg2, ..., body)` constructs a function from string
// source — same attack surface as eval. The body is the LAST argument; the
// preceding strings are formal parameter names. We rewrite only the body.
//
// The server's JS rewriter doesn't catch this because the construction is
// fully runtime — there's no static call site to wrap. Hence the prototype
// patch. Mirrors the role wrap_eval / wrap_eval_arg play for eval.
//
// Both `Function(...)` (call) and `new Function(...)` are supported — both
// dispatch through the same intercept.
//
// We deliberately do NOT patch `Function.prototype` — that's the prototype
// of every callable, and replacing it would break much of the JS runtime.
// The native `Function` constructor's prototype property still points at
// the genuine one.

import { defaultJsRewriteOptions, rewriteJsSource } from "../js/rewriter";

let patched = false;

export function patchFunctionConstructor(_targetWindow: Window): void {
    if (patched) return;

    const NativeFunction = (globalThis as unknown as {
        Function: FunctionConstructor;
    }).Function;
    if (!NativeFunction) return;

    function PatchedFunction(this: unknown, ...args: unknown[]): Function {
        // Rewrite the body (last arg) if it's a string. Param-name strings
        // (preceding args) don't carry URLs and don't need rewriting.
        const argsCopy = args.slice();
        const lastIndex = argsCopy.length - 1;
        if (lastIndex >= 0 && typeof argsCopy[lastIndex] === "string") {
            argsCopy[lastIndex] = rewriteJsSource(
                argsCopy[lastIndex] as string,
                defaultJsRewriteOptions(),
            );
        }
        // `new NativeFunction(...args)` works for both call and construct
        // forms — Function's constructor is callable in both modes and
        // produces the same result.
        return Reflect.construct(NativeFunction, argsCopy);
    }

    // Preserve prototype chain so `instanceof Function` still works for
    // anything constructed via the patched constructor.
    PatchedFunction.prototype = NativeFunction.prototype;
    Object.setPrototypeOf(PatchedFunction, NativeFunction);

    (globalThis as unknown as { Function: FunctionConstructor }).Function =
        PatchedFunction as unknown as FunctionConstructor;

    patched = true;
}
