// `obj?.location`, `a?.b.top`, … — member accesses the JS rewriters wrap as
// `$rewriter.wrap_x({obj, opt: 1})?.x` when they sit in an optional chain.
// Natively a nullish obj short-circuits the chain to undefined; the helper's
// holder object is never nullish, so for `opt` and a nullish obj the helper
// returns undefined and the `?.` after it short-circuits as the native did.

const HELPERS = ["wrap_location", "wrap_top_window", "wrap_parent_window", "wrap_document_write", "wrap_postMessage"];

export function honourOptionalChains<T extends object>(api: T): T {
    const a = api as Record<string, unknown>;
    for (const name of HELPERS) {
        const helper = a[name];
        if (typeof helper !== "function") continue;
        a[name] = (arg: { obj: unknown; opt?: unknown }): unknown =>
            arg && arg.opt && (arg.obj === null || arg.obj === undefined) ? undefined : (helper as (x: unknown) => unknown)(arg);
    }
    return api;
}
