// Wrappers for the eval-family server-AST-rewrites.
//
// The server emits three variants in place of bare `eval(src)`,
// `var f = eval`, and `obj.eval(...)`:
//
//   eval(src, ...)  →  eval($rewriter.wrap_eval_arg(eval, src), ...)
//   var f = eval    →  var f = $rewriter.wrap_eval(eval)
//   obj.eval(...)   →  $rewriter.wrap_eval_memexp(obj).eval(...)
//
// Each wrapper's job is to apply the JS source rewriter to whatever JS string
// would otherwise reach an unmodified eval — closing the equivalent leak the
// server's HTML/JS pass closes for static source.
//
// Implementation notes:
//   - wrap_eval_arg rewrites the source argument and returns it. The
//     surrounding `eval(...)` call still uses bare eval — that's intentional,
//     since it preserves direct-eval semantics (access to the calling scope),
//     which an indirect call through a wrapper would break.
//   - wrap_eval returns a function that, when called, rewrites its first
//     string argument and forwards to the real eval. This handles the
//     `var f = eval; f("...")` pattern, where wrap_eval_arg has nowhere to
//     attach. NOTE: this loses direct-eval scope access, matching what the
//     server's documentation calls out.
//   - wrap_eval_memexp returns a Proxy of `obj` whose `.eval` property is a
//     function that rewrites its first string argument before delegating to
//     the real `obj.eval`. Every other property/method passes through to
//     `obj` unchanged. Plugs the `obj.eval(src)` leak that previously fell
//     through to the bare eval at the call site.

import { isTrustedValue, realmOfFunction, trusted } from "../native/trusted";
import { defaultJsRewriteOptions, rewriteJsSource } from "../js/rewriter";
import { maskAs, standIn } from "../native/surface";

// A page that reads `eval` — `var f = eval`, `window.eval`, a challenge
// script listing its own property names, its prototype and its source —
// must get one function per realm that is the native in every respect but
// the source it runs (the page cannot tell): a Proxy of the native, so its
// name, length, absent `prototype` and own keys are the native's, read by
// Function.prototype.toString as the native, and the same object each time.
const wrappers = new WeakMap<object, object>();
const wrapped = new WeakSet<object>();
/** stand-in → the native eval it stands for. */
const natives = new WeakMap<object, typeof eval>();

/** The stand-in for a realm's `eval`: rewrites a string source, then calls it (an indirect eval, as any call through a value is). */
export function wrapEval(nativeEval: typeof eval): typeof eval {
    if (typeof nativeEval !== "function" || wrapped.has(nativeEval)) return nativeEval;
    const hit = wrappers.get(nativeEval);
    if (hit) return hit as typeof eval;
    const w = maskAs(standIn(nativeEval, {
        apply(target, self, args: unknown[]) {
            if (isTrustedValue(args[0])) {
                return Reflect.apply(target, self, [trusted(realmOf(target), "Script", rewriteJsSource(String(args[0]), defaultJsRewriteOptions())), ...args.slice(1)]);
            }
            if (typeof args[0] !== "string") return Reflect.apply(target, self, args);
            return Reflect.apply(target, self, [rewriteJsSource(args[0], defaultJsRewriteOptions()), ...args.slice(1)]);
        },
    }), nativeEval);
    wrappers.set(nativeEval, w);
    wrapped.add(w);
    natives.set(w, nativeEval);
    return w;
}

export function wrapEvalArg(_nativeEval: typeof eval, source: unknown): unknown {
    // A TrustedScript (what a page under Trusted Types must give eval) is
    // rewritten like a string, and stays trusted.
    if (isTrustedValue(source)) {
        return trusted(realmOf(_nativeEval), "Script", rewriteJsSource(String(source), defaultJsRewriteOptions()));
    }
    if (typeof source !== "string") return source;
    return rewriteJsSource(source, defaultJsRewriteOptions());
}

/** The global object of the realm an eval (or its stand-in) belongs to. */
function realmOf(fn: unknown): object {
    return realmOfFunction((typeof fn === "function" && natives.get(fn)) || fn);
}

/**
 * Returns a proxy of `obj` whose `.eval` is a function that rewrites its
 * first string argument before calling through. Every other access falls
 * through to `obj` unchanged.
 *
 * Returns `obj` unchanged for primitives / null — Proxy can only wrap
 * objects.
 */
export function wrapEvalMemexp(obj: unknown): unknown {
    if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) {
        return obj;
    }
    // Only a global object's `eval` is the evaluator; any other object's
    // `eval` property is its own, read and assigned as written.
    let isGlobal = false;
    try {
        const o = obj as { window?: unknown; self?: unknown };
        isGlobal = o.window === obj || o.self === obj;
    } catch { /* a cross-origin window: its eval is not reachable anyway */ }
    if (!isGlobal) return obj;
    const target = obj as object;
    return new Proxy(target, {
        get(_t, prop, receiver) {
            if (prop === "eval") {
                const realEval = Reflect.get(target, prop, receiver);
                if (typeof realEval !== "function") return realEval;
                // The realm's own evaluator gets its stand-in; an `eval`
                // the page assigned over it is the page's own function.
                return isEvaluator(realEval) ? wrapEval(realEval as typeof eval) : realEval;
            }
            return Reflect.get(target, prop, receiver);
        },
    });
}

/** True for a realm's intrinsic eval (a native function named "eval"), not a function the page put in its place. */
function isEvaluator(f: Function): boolean {
    if (wrapped.has(f)) return false;
    try {
        return f.name === "eval" && !Object.prototype.hasOwnProperty.call(f, "prototype") &&
            /\[native code\]/.test(Function.prototype.toString.call(f));
    } catch {
        return false;
    }
}
