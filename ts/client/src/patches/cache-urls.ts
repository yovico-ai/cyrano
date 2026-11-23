// The Cache API's requests (toyotaofbellevue.com, 2026-11-22: gubagoo's
// loader cached its scripts with `cache.add(url)`, which fetched them from
// their origins). Cache.add / addAll fetch what they are given themselves;
// every Cache method keys its entries by request URL. A page's own
// `new Request(url)` is proxified already (fetch.ts), so a string or URL
// object given to any of them is proxified the same way: an entry is keyed
// by the proxified URL whichever form the page used, and found by either.
// Request.url / Response.url read back unwrapped (fetch.ts), so keys() and
// a match's response show the page's URLs.

import { nR } from "../native/intrinsics";
import { wrapMethod } from "../native/surface";

export function patchCacheUrls(scope: object, rewriteOne: (url: string) => string): void {
    const g = scope as Record<string, { prototype?: object } | undefined>;
    const NativeRequest = g["Request"] as unknown as (abstract new (...a: never[]) => object) | undefined;
    const NativeURL = g["URL"] as unknown as (abstract new (...a: never[]) => object) | undefined;
    /** A request as the page gave it, in the form the cache keys it by. */
    const key = (r: unknown): unknown => {
        if (typeof r === "string") return rewriteOne(r);
        if (NativeURL && r instanceof NativeURL) return rewriteOne(String(r));
        if (NativeRequest && r instanceof NativeRequest) return r;
        return r; // anything else: the native's conversion and errors
    };
    const C = g["Cache"]?.prototype;
    if (C) {
        for (const name of ["add", "match", "matchAll", "delete", "keys", "put"]) {
            wrapMethod<(...a: unknown[]) => unknown>(C, name, (native, self, args) =>
                nR.apply(native, self, args.length && args[0] !== undefined ? [key(args[0]), ...args.slice(1)] : args));
        }
        wrapMethod<(...a: unknown[]) => unknown>(C, "addAll", (native, self, args) => {
            const list = args[0];
            if (list === null || typeof list !== "object" || typeof (list as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== "function") {
                return nR.apply(native, self, args);
            }
            const out: unknown[] = [];
            for (const r of list as Iterable<unknown>) out[out.length] = key(r);
            return nR.apply(native, self, [out, ...args.slice(1)]);
        });
    }
    const S = g["CacheStorage"]?.prototype;
    if (S) {
        wrapMethod<(...a: unknown[]) => unknown>(S, "match", (native, self, args) =>
            nR.apply(native, self, args.length ? [key(args[0]), ...args.slice(1)] : args));
    }
}
