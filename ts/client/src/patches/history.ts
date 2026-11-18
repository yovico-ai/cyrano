// History.prototype.pushState / replaceState, as page code sees them
// natively.
//
// The URL argument is resolved against the page's original URL and
// proxified. Natively a URL of another origin throws a SecurityError; under
// cyrano every proxified URL is on the proxy origin, so that check is made
// here against the original origins, with Chromium's message. After the
// native call the page's base URL follows the real location — for every
// change, a "#fragment" one included.

import { wrapMethod } from "../native/surface";

export function patchHistory(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
    setBaseUrl: (href: string) => void,
    unwrapOne: (proxied: string) => string,
    baseUrl: () => URL,
): void {
    const H = (targetWindow as unknown as { History?: { prototype: History } }).History;
    if (!H?.prototype) return;
    const realLocation = targetWindow.location;
    const Dom = (targetWindow as unknown as { DOMException: typeof DOMException }).DOMException;
    const follow = (): void => {
        const original = unwrapOne(realLocation.href);
        if (original !== realLocation.href) setBaseUrl(original);
    };
    for (const name of ["pushState", "replaceState"] as const) {
        wrapMethod<(...a: unknown[]) => void>(H.prototype, name, (native, self, args) => {
            if (args.length < 3 || args[2] == null) return Reflect.apply(native, self, args) as void;
            const raw = String(args[2]);
            const base = baseUrl();
            let target: URL | null = null;
            try { target = new URL(raw, base); } catch { /* the native's own error below */ }
            // A URL already on the proxy is cyrano's own (read back from the
            // real location by code cyrano did not rewrite): passed through.
            if (target && target.origin !== base.origin && unwrapOne(target.href) === target.href) {
                throw new Dom(
                    `Failed to execute '${name}' on 'History': A history state object with URL '${target.href}' ` +
                    `cannot be created in a document with origin '${base.origin}' and URL '${base.href}'.`,
                    "SecurityError");
            }
            const next = args.slice();
            next[2] = target ? rewriteOne(raw) : raw;
            Reflect.apply(native, self, next);
            follow();
        });
    }
    targetWindow.addEventListener("popstate", follow);
    targetWindow.addEventListener("hashchange", follow);
}
