// Two browser-made channels that left the proxy (round J):
//   * `new WebTransport(url)` connected over QUIC straight to the origin.
//     The proxy carries no HTTP/3: the URL is proxified, so the attempt
//     goes to the proxy's host and fails there — `ready` rejects with the
//     native's WebTransportError, as for a server that cannot be reached
//     (sites fall back to WebSocket) — never around it.
//   * the window `documentPictureInPicture.requestWindow()` opens is an
//     empty same-origin window its opener scripts, as a blank popup: it
//     gets the opener's runtime before the page is handed it (what the page
//     put in it, its fetch, its origin went around the proxy).

import { nO, nR, ncall } from "../native/intrinsics";
import { wrapConstructor, wrapMethod } from "../native/surface";
import { injectIntoWindow } from "../runtime/iframe-injection";
import type { ClientConfig } from "../config";

// Saved at load: a page may replace it.
const nThen = Promise.prototype.then;

/** A WebTransport URL, aimed at the proxy (https: the constructor takes no other; the attempt fails there). */
function toProxy(url: string, rewriteOne: (url: string) => string): string {
    let u: URL;
    try { u = new URL(url); } catch { return url; } // the native's own SyntaxError
    if (u.protocol !== "https:") return url; // the native's own refusal
    const to = rewriteOne(url);
    return to.replace(/^http:/i, "https:");
}

export function patchWebTransport(scope: object, rewriteOne: (url: string) => string): void {
    if (typeof (scope as Record<string, unknown>)["WebTransport"] !== "function") return;
    wrapConstructor<new (...a: unknown[]) => object>(scope, "WebTransport", (Native, args, newTarget) =>
        nR.construct(Native, args.length ? [toProxy(String(args[0]), rewriteOne), ...args.slice(1)] : args, newTarget as never) as object);
}

export function patchPictureInPicture(targetWindow: Window, config: ClientConfig, base: () => URL): void {
    const P = (targetWindow as unknown as Record<string, { prototype: object } | undefined>)["DocumentPictureInPicture"]?.prototype;
    if (!P || typeof nO.getOwnPropertyDescriptor(P, "requestWindow")?.value !== "function") return;
    wrapMethod<(...a: unknown[]) => unknown>(P, "requestWindow", (native, self, args) => {
        const p = nR.apply(native, self, args);
        // The page's promise settles as the native's, the window given the runtime first.
        return ncall(nThen as (this: unknown, a: unknown) => unknown, p, (w: unknown) => {
            try { if (w && typeof w === "object") injectIntoWindow(w as Window, targetWindow, config, base().href); } catch { /* as it is */ }
            return w;
        });
    });
}
