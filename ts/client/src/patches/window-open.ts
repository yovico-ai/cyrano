// window.open(url, target, features), as page code sees it natively; only a
// given, non-empty URL is proxified (rewriteUrl itself leaves about:,
// javascript:, blob:, data: … as written). The features' attributionsrc
// URLs, which the browser requests itself, are proxified in place
// (spec/Features.agda); the rest of the string is passed as written.
//
// A window opened on about:blank (no URL, "", about:blank — the usual
// OAuth / payment popup, opened in the click and sent somewhere later, or
// written into) is given its opener's runtime, as an empty frame is its
// creator's: what the page writes into it, and where it sends it, goes
// through the proxy (round H: its images, its location set by the opener
// went to their origins; its document.cookie was the browser's raw jar).

import { nR } from "../native/intrinsics";
import { crossOriginView } from "../native/cross-origin";
import { wrapMethod } from "../native/surface";
import { decodeSource, mapSources } from "../url/features";
import { injectIntoWindow } from "../runtime/iframe-injection";
import type { ClientConfig } from "../config";

/** An opened window still on about: gets the opener's runtime. */
function giveRuntime(w: Window | null, opener: Window, config: ClientConfig | undefined, base: (() => URL) | undefined): void {
    if (!w || !config || !base || w === opener) return;
    try {
        if (!/^about:/i.test(String(w.location.href))) return;
        injectIntoWindow(w, opener, config, base().href);
    } catch { /* another origin's window: nothing to give */ }
}

export function patchWindowOpen(targetWindow: Window, rewriteOne: (url: string) => string, config?: ClientConfig, base?: () => URL): void {
    wrapMethod<(...a: unknown[]) => Window | null>(targetWindow, "open", (native, self, a) => {
        let args = a;
        if (typeof args[2] === "string" && args[2] !== "") {
            const features = mapSources(args[2], (v) => encodeURIComponent(rewriteOne(decodeSource(v))));
            if (features !== args[2]) args = [args[0], args[1], features, ...args.slice(3)];
        }
        // The opened window is another window: cross-origin, it is a view.
        if (!args.length || args[0] == null || String(args[0]) === "") {
            const w = nR.apply(native, self, args) as Window | null;
            giveRuntime(w, targetWindow, config, base);
            return crossOriginView(w, null, targetWindow);
        }
        const given = String(args[0]);
        const w = nR.apply(native, self, [rewriteOne(given), ...args.slice(1)]) as Window | null;
        if (/^\s*about:/i.test(given)) giveRuntime(w, targetWindow, config, base);
        // On its way to that URL's origin: it is that origin's already (the
        // popup is still on about:blank when open returns; judged so, it was
        // handed out as same-origin, and its document stayed readable).
        let pending: string | null = null;
        try {
            const u = new URL(given, base ? base().href : undefined);
            if (u.protocol === "http:" || u.protocol === "https:") pending = u.origin;
        } catch { pending = null; }
        return crossOriginView(w, pending, targetWindow);
    });
}
