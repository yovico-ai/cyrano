// Function(...) / new Function(...), as page code sees them natively: the
// body is JS-rewritten before the native compiles it.
//
// The wrapper is a Proxy of the native for both call and construct; it
// replaces the global and Function.prototype.constructor, so
// (function(){}).constructor reaches it too and still === Function. A
// function made this way prints the page's own source: its toString is
// masked by a native twin compiled — never run — from the original
// arguments ("function anonymous(…) {…}").
//
// Known gap: the AsyncFunction, GeneratorFunction and AsyncGeneratorFunction
// constructors, reachable as (async () => {}).constructor etc., are not
// wrapped yet.

import { defaultJsRewriteOptions, rewriteJsSource } from "../js/rewriter";
import { maskAs, replaceValue } from "../native/surface";

export function patchFunctionConstructor(targetWindow: Window): void {
    const g = targetWindow as unknown as { Function?: FunctionConstructor };
    const NativeFunction = g.Function;
    if (!NativeFunction || maskedRealms.has(NativeFunction)) return;
    maskedRealms.add(NativeFunction);
    const make = (args: unknown[], newTarget?: unknown): unknown => {
        const body = args.length ? args[args.length - 1] : undefined;
        if (typeof body !== "string") return Reflect.construct(NativeFunction, args, (newTarget ?? NativeFunction) as FunctionConstructor);
        const twin = Reflect.construct(NativeFunction, args) as object; // the page's own source; throws as natively
        const rewritten = args.slice();
        rewritten[rewritten.length - 1] = rewriteJsSource(body, defaultJsRewriteOptions());
        const fn = Reflect.construct(NativeFunction, rewritten, (newTarget ?? NativeFunction) as FunctionConstructor) as object;
        return maskAs(fn, twin);
    };
    const wrapper: FunctionConstructor = new Proxy(NativeFunction, {
        apply: (_t, _self, args: unknown[]) => make(args),
        construct: (_t, args: unknown[], newTarget: unknown) => make(args, newTarget === wrapper ? NativeFunction : newTarget) as object,
    });
    maskAs(wrapper, NativeFunction);
    replaceValue(NativeFunction.prototype, "constructor", wrapper);
    replaceValue(targetWindow, "Function", wrapper);
}

const maskedRealms = new WeakSet<object>();
