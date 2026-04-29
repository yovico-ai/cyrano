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

import { defaultJsRewriteOptions, rewriteJsSource } from "../js/rewriter";

export function wrapEval(nativeEval: typeof eval): typeof eval {
    return ((source: unknown, ...rest: unknown[]) => {
        if (typeof source !== "string") {
            return nativeEval(source as string, ...(rest as []));
        }
        const rewritten = rewriteJsSource(source, defaultJsRewriteOptions());
        return nativeEval(rewritten, ...(rest as []));
    }) as typeof eval;
}

export function wrapEvalArg(_nativeEval: typeof eval, source: unknown): unknown {
    if (typeof source !== "string") return source;
    return rewriteJsSource(source, defaultJsRewriteOptions());
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
    const target = obj as object;
    return new Proxy(target, {
        get(_t, prop, receiver) {
            if (prop === "eval") {
                const realEval = Reflect.get(target, prop, receiver);
                if (typeof realEval !== "function") return realEval;
                return function patchedEval(this: unknown, src: unknown, ...rest: unknown[]) {
                    // When the proxy is used as the call target's receiver
                    // (`proxy.eval(src)`), `this` is the proxy. Forward to
                    // the underlying object so the real eval has correct
                    // semantics. If the caller bound `this` explicitly,
                    // honour that.
                    const callThis = this === receiver ? target : this;
                    if (typeof src !== "string") {
                        return Reflect.apply(realEval as Function, callThis, [src, ...rest]);
                    }
                    const rewritten = rewriteJsSource(src, defaultJsRewriteOptions());
                    return Reflect.apply(realEval as Function, callThis, [rewritten, ...rest]);
                };
            }
            return Reflect.get(target, prop, receiver);
        },
    });
}
