// R15: `import.meta.resolve` → `$rewriter.wrap_meta_resolve(import.meta)`.
//
// The native resolves against the module's own URL — the proxied one — so
// a root-relative specifier ("/a.js") lands on the proxy's root, and every
// answer names the proxy. The stand-in resolves as import() does (R7: a
// URL-like specifier proxified against the module's original URL, a bare
// one left to the import map, whose addresses are proxified), calls the
// native with that, and hands back the original URL: what the native
// gives direct. Its errors are the native's own.

import type { ClientConfig } from "../config";
import { SafeWeakMap, nR } from "../native/intrinsics";
import { maskAs, standIn } from "../native/surface";
import { isUrlLikeSpecifier, rewriteUrl, unwrapProxiedUrl } from "../url/containment";

type Resolve = (specifier: unknown) => string;

export function metaResolver(config: ClientConfig): (meta: unknown) => unknown {
    // One stand-in per module's native, so `resolve === resolve` holds.
    const made = new SafeWeakMap<object, Resolve>();
    return (meta) => {
        const native = (meta as { resolve?: unknown }).resolve;
        if (typeof native !== "function") return native;
        let f = made.get(native);
        if (!f) {
            f = standIn(native as Resolve, {
                apply: (target, self, args) => {
                    if (args.length === 0) return nR.apply(target, self, args);
                    const s = `${args[0] as string}`; // ToString, as the native (a Symbol throws)
                    let spec = s;
                    if (isUrlLikeSpecifier(s)) {
                        try {
                            const own = (meta as { url: string }).url;
                            spec = rewriteUrl(s, new URL(unwrapProxiedUrl(own, config)), config, undefined, "js");
                        } catch { /* the native's answer */ }
                    }
                    const r = nR.apply(target, self, [spec]) as unknown;
                    return typeof r === "string" ? unwrapProxiedUrl(r, config) : r;
                },
            });
            maskAs(f, native);
            made.set(native, f);
        }
        return f;
    };
}
