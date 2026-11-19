// Function(...) / new Function(...), as page code sees them natively: the
// body is JS-rewritten before the native compiles it.
//
// The wrapper is a function of its own, named Function, with the native's
// prototype object, length and [[Prototype]]; it
// replaces the global and Function.prototype.constructor, so
// (function(){}).constructor reaches it too and still === Function. A
// function made this way prints the page's own source: its toString is
// masked by a native twin compiled — never run — from the original
// arguments ("function anonymous(…) {…}").
//
// Known gap: the AsyncFunction, GeneratorFunction and AsyncGeneratorFunction
// constructors, reachable as (async () => {}).constructor etc., are not
// wrapped yet.

import { SafeWeakSet, nO, nR } from "../native/intrinsics";
import { defaultJsRewriteOptions, rewriteJsSource } from "../js/rewriter";
import { maskAs, replaceValue } from "../native/surface";
import { isTrustedValue, trusted } from "../native/trusted";

export function patchFunctionConstructor(targetWindow: Window): void {
    const g = targetWindow as unknown as { Function?: FunctionConstructor };
    const NativeFunction = g.Function;
    if (!NativeFunction || maskedRealms.has(NativeFunction)) return;
    maskedRealms.add(NativeFunction);
    const make = (args: unknown[], newTarget?: unknown): unknown => {
        let body = args.length ? args[args.length - 1] : undefined;
        // A TrustedScript body (Trusted Types) is rewritten like a string, and stays trusted.
        const wasTrusted = isTrustedValue(body);
        if (wasTrusted) body = String(body);
        if (typeof body !== "string") return nR.construct(NativeFunction, args, (newTarget ?? NativeFunction) as FunctionConstructor);
        const twin = nR.construct(NativeFunction, args) as object; // the page's own source; throws as natively
        const rewritten = args.slice();
        const code = rewriteJsSource(body, defaultJsRewriteOptions());
        rewritten[rewritten.length - 1] = wasTrusted ? trusted(targetWindow, "Script", code) : code;
        const fn = nR.construct(NativeFunction, rewritten, (newTarget ?? NativeFunction) as FunctionConstructor) as object;
        return maskAs(fn, twin);
    };
    // A real function, named Function: where a script's object inherits
    // `constructor` from Function.prototype, V8 names it by that function
    // ("at Function.toString (<anonymous>)" in a stack) — and falls back to
    // "Object" when it finds a Proxy there.
    // (Named through the property it is defined as: a bundler renames a
    // function declared `Function`.)
    const wrapper = ({
        Function: function (this: unknown, ...args: unknown[]): unknown {
            const nt = new.target as unknown;
            return make(args, nt === undefined || nt === wrapper ? undefined : nt);
        },
    }).Function as unknown as FunctionConstructor;
    nO.defineProperty(wrapper, "length", { value: NativeFunction.length, writable: false, enumerable: false, configurable: true });
    nO.defineProperty(wrapper, "prototype", { value: NativeFunction.prototype, writable: false, enumerable: false, configurable: false });
    nO.setPrototypeOf(wrapper, nO.getPrototypeOf(NativeFunction) as object);
    maskAs(wrapper, NativeFunction);
    replaceValue(NativeFunction.prototype, "constructor", wrapper);
    replaceValue(targetWindow, "Function", wrapper);
}

const maskedRealms = new SafeWeakSet<object>();
