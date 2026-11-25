// Worklet modules: `addModule(url)` on any worklet (CSS.paintWorklet, an
// audio context's audioWorklet, sharedStorage.worklet, layout / animation
// worklets: one Worklet.prototype) and `sharedStorage.createWorklet(url)`.
//
// The browser fetches the module itself, so its URL went to its origin
// outside the proxy (a relative one to the proxy's root). It is resolved
// against the page's base and proxified, unmarked: the server knows a
// worklet's module by its Sec-Fetch-Dest and gives it only the JS rules
// that need no runtime, which a worklet global has none of
// (spec/Disposition.agda workletDest). A blob: or data: module the page
// made is read, rewritten the same way into a private object URL — its
// static imports proxified against the URL the page gave, import.meta.url
// that URL (with the page's origin for a blob:) — the page's own Blob
// untouched. A TrustedScriptURL stays trusted.

import { SafeMap, nO, nR, sStarts } from "../native/intrinsics";
import { wrapMethod } from "../native/surface";
import { isTrustedValue, trusted } from "../native/trusted";
import { readBlob } from "./blob-worker-source";
import { rewriteJsSource, workletJsRewriteOptions } from "../js/rewriter";
import { rewriteUrl } from "../url/containment";
import type { ClientConfig } from "../config";

export function patchWorklets(
    targetWindow: Window,
    config: ClientConfig,
    getCurrentBaseUrl: () => URL,
): void {
    const w = targetWindow as unknown as {
        Worklet?: { prototype: object }; SharedStorage?: { prototype: object };
        URL?: typeof URL; Blob?: typeof Blob;
    };
    const proxify = (u: string): string => rewriteUrl(u, getCurrentBaseUrl(), config);
    const privateUrl = new SafeMap<string, string>();
    const createUrl = w.URL ? nO.getOwnPropertyDescriptor(w.URL, "createObjectURL")?.value as ((o: object) => string) | undefined : undefined;
    const NativeBlob = w.Blob;

    /** The URL the native is given for the page's module URL. */
    const moduleUrl = (given: string): string => {
        let abs: URL;
        try { abs = new URL(given, getCurrentBaseUrl()); } catch { return given; } // the native's own error
        if (abs.protocol === "http:" || abs.protocol === "https:") return proxify(abs.href);
        if (abs.protocol !== "blob:" && abs.protocol !== "data:") return given;
        const hit = privateUrl.get(abs.href);
        if (hit) return hit;
        const src = readBlob(targetWindow, abs.href, "text/javascript; charset=utf-8");
        if (!src || !createUrl || !NativeBlob || !w.URL) return given;
        // The module's own URL as the page sees it: a blob: of the page's
        // origin (the page made it on the proxy's).
        let own = abs.href;
        try {
            const proxyOrigin = new URL(config.apiBaseURL).origin;
            if (sStarts(own, "blob:" + proxyOrigin + "/")) own = "blob:" + getCurrentBaseUrl().origin + own.slice(5 + proxyOrigin.length);
        } catch { /* as given */ }
        const opts = workletJsRewriteOptions();
        opts.baseUrl = own;
        opts.proxify = (specifier: string, from: string): string => {
            try {
                const t = new URL(specifier, from);
                return t.protocol === "http:" || t.protocol === "https:" ? proxify(t.href) : specifier;
            } catch { return specifier; }
        };
        const body = rewriteJsSource(src.source, opts);
        const priv = nR.apply(createUrl, w.URL, [new NativeBlob([body], { type: src.type || "text/javascript" })]) as string;
        privateUrl.set(abs.href, priv);
        return priv;
    };

    const wrapUrlArg = (proto: object | undefined, name: string): void => {
        if (!proto || typeof (proto as Record<string, unknown>)[name] !== "function") return;
        wrapMethod<(...a: unknown[]) => unknown>(proto, name, (native, self, args) => {
            if (!args.length || typeof args[0] === "symbol") return nR.apply(native, self, args);
            const given = args[0];
            const url = moduleUrl(String(given));
            const arg = isTrustedValue(given) ? trusted(targetWindow, "ScriptURL", url) : url;
            return nR.apply(native, self, [arg, ...args.slice(1)]);
        });
    };
    wrapUrlArg(w.Worklet?.prototype, "addModule");
    wrapUrlArg(w.SharedStorage?.prototype, "createWorklet");
}
