// Globally patches window.location (and document.URL / document.referrer)
// so that ALL scripts on the page — including unmodified third-party scripts
// such as Cloudflare Bot Management challenge.js — see the upstream URL
// rather than the proxy URL (http://localhost:9081/?goto=...).
//
// Without this patch, challenge scripts read window.location.href → get the
// proxy URL → include it in fingerprint data sent to Cloudflare → Cloudflare
// rejects the challenge because the URL doesn't match the expected domain.
//
// The override is best-effort: some browsers / CSPs may prevent redefining
// window.location. The try/catch ensures a failure is silent and the rewriter
// still works for the scripts it rewrites directly.

import type { WrappedLocation } from "../wrappers/wrapped-location";

export function patchWindowLocation(
    targetWindow: Window,
    wrappedLocation: WrappedLocation,
    getReferer: () => string,
): void {
    // Override window.location with an own-property so all reads (including
    // from unmodified scripts) return the upstream URL.
    try {
        Object.defineProperty(targetWindow, "location", {
            get(): WrappedLocation { return wrappedLocation; },
            set(url: string) { wrappedLocation.href = url; },
            configurable: true,
            enumerable: true,
        });
    } catch {
        // Browser may refuse to redefine window.location (non-configurable).
        // Non-fatal: rewritten scripts still get the correct location via
        // wrap_get_location; only unmodified scripts are affected.
    }

    // document.URL mirrors window.location.href in browsers.
    // document.baseURI is the same when there is no <base> element — it drives
    // how relative URLs are resolved (e.g. new URL('/_astro/foo.js', document.baseURI)).
    // Without this patch, chunk-loaders resolve relative module paths against the
    // proxy origin, producing bare http://localhost:9081/... URLs that bypass the
    // proxy containment.
    try {
        const urlDescriptor = {
            get(): string { return wrappedLocation.href; },
            configurable: true,
        };
        Object.defineProperty(targetWindow.document, "URL", urlDescriptor);
        Object.defineProperty(targetWindow.document, "baseURI", urlDescriptor);
    } catch { /* non-fatal */ }

    // document.referrer is checked by some anti-bot systems to verify the
    // request came from the expected domain.
    try {
        const fakeReferrer = getReferer();
        if (fakeReferrer) {
            Object.defineProperty(targetWindow.document, "referrer", {
                get(): string { return fakeReferrer; },
                configurable: true,
            });
        }
    } catch { /* non-fatal */ }
}
