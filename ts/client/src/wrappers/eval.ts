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

import { SafeWeakMap, SafeWeakSet, nOP, nR, ncall } from "../native/intrinsics";
import { isWindowObject } from "../native/brand";
import { isTrustedValue, realmOfFunction, trusted } from "../native/trusted";
import { rewriteJsSource } from "../js/rewriter";
import { madeCodeOptions } from "../js/made-code";
import { maskAs, standIn } from "../native/surface";
import { sharedData } from "../native/shared";

// A page that reads `eval` — `var f = eval`, `window.eval`, a challenge
// script listing its own property names, its prototype and its source —
// must get one function per realm that is the native in every respect but
// the source it runs (the page cannot tell): a Proxy of the native, so its
// name, length, absent `prototype` and own keys are the native's, read by
// Function.prototype.toString as the native, and the same object each time.
// (One set for a page tree — native/shared.ts: a realm's eval has one
// stand-in, whichever copy of the runtime is asked for it.)
// Function.prototype.toString as it was at load: the page's own may lie.
const nFnToString = Function.prototype.toString;
const wrappers = sharedData("eval.wrappers", () => new SafeWeakMap<object, object>());
const wrapped = sharedData("eval.wrapped", () => new SafeWeakSet<object>());
/** stand-in → the native eval it stands for. */
const natives = sharedData("eval.natives", () => new SafeWeakMap<object, typeof eval>());

/** The stand-in for a realm's `eval`: rewrites a string source, then calls it (an indirect eval, as any call through a value is). */
export function wrapEval(nativeEval: typeof eval): typeof eval {
    if (typeof nativeEval !== "function" || wrapped.has(nativeEval)) return nativeEval;
    const hit = wrappers.get(nativeEval);
    if (hit) return hit as typeof eval;
    const w = maskAs(standIn(nativeEval, {
        apply(target, self, args: unknown[]) {
            if (isTrustedValue(args[0])) {
                return nR.apply(target, self, [trusted(realmOf(target), "Script", rewriteJsSource(String(args[0]), madeCodeOptions(realmOf(target), String(args[0])))), ...args.slice(1)]);
            }
            if (typeof args[0] !== "string") return nR.apply(target, self, args);
            return nR.apply(target, self, [rewriteJsSource(args[0], madeCodeOptions(realmOf(target), args[0])), ...args.slice(1)]);
        },
    }), nativeEval);
    wrappers.set(nativeEval, w);
    wrapped.add(w);
    natives.set(w, nativeEval);
    return w;
}

// Every realm's intrinsic eval, recorded by the runtime as it loads in that
// realm (before any page code), one set for the page tree (native/shared.ts).
const intrinsics = sharedData("eval.intrinsics", () => new SafeWeakSet<object>());
/** Records a realm's intrinsic eval (called with the window's own eval at load). */
export function registerEvaluator(f: unknown): void {
    if (typeof f === "function" && !wrapped.has(f)) intrinsics.add(f);
}
/** Whether f is some realm's intrinsic eval (spec/Eval.agda Callee intrinsic). */
export function isIntrinsicEval(f: unknown): boolean {
    if (typeof f !== "function") return false;
    return intrinsics.has(f) || isEvaluator(f);
}

/**
 * R6 / R16 / R17: the source a call hands to eval, rewritten — only when
 * the callee is an evaluator; anything else gets its argument as it is
 * (spec/Eval.agda: passthrough). A stand-in rewrites for itself.
 */
export function wrapEvalArg(_nativeEval: typeof eval, source: unknown): unknown {
    if (!isIntrinsicEval(_nativeEval)) return source;
    // A TrustedScript (what a page under Trusted Types must give eval) is
    // rewritten like a string, and stays trusted.
    if (isTrustedValue(source)) {
        return trusted(realmOf(_nativeEval), "Script", rewriteJsSource(String(source), madeCodeOptions(realmOf(_nativeEval), String(source))));
    }
    if (typeof source !== "string") return source;
    return rewriteJsSource(source, madeCodeOptions(realmOf(_nativeEval), source));
}

/** R16 F.apply(t, arr): the arguments with the first rewritten when F is an evaluator. */
export function wrapEvalArgs(f: unknown, args: unknown): unknown {
    if (!isIntrinsicEval(f) || args === null || typeof args !== "object") return args;
    const a = args as ArrayLike<unknown>;
    const n = a.length;
    if (typeof n !== "number" || n < 1) return args;
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) out[i] = a[i];
    out[0] = wrapEvalArg(f as typeof eval, out[0]);
    return out;
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
    // (Told apart without reading the object: native/brand.ts.)
    if (!isWindowObject(obj) && obj !== globalThis) return obj;
    const target = obj as object;
    return new Proxy(target, {
        get(_t, prop, receiver) {
            if (prop === "eval") {
                const realEval = nR.get(target, prop, receiver);
                if (typeof realEval !== "function") return realEval;
                // The realm's own evaluator gets its stand-in; an `eval`
                // the page assigned over it is the page's own function.
                return isEvaluator(realEval) ? wrapEval(realEval as typeof eval) : realEval;
            }
            return nR.get(target, prop, receiver);
        },
    });
}

/** True for a realm's intrinsic eval (a native function named "eval"), not a function the page put in its place. */
function isEvaluator(f: Function): boolean {
    if (wrapped.has(f)) return false;
    try {
        return f.name === "eval" && !ncall(nOP.hasOwnProperty, f, "prototype") &&
            /\[native code\]/.test(ncall(nFnToString, f));
    } catch {
        return false;
    }
}
