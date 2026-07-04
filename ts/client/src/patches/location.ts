// Patches document.URL / document.baseURI / document.referrer so scripts on
// the page see the upstream URL rather than the proxy URL.
//
// window.location is [LegacyUnforgeable] (non-configurable own property on
// window) and all Location properties are non-configurable own getters on the
// Location instance — neither window.location nor Location.prototype can be
// patched at runtime in any browser. The correct approach is the JS AST
// rewriter: every `location.*` access in rewritten scripts is transformed to
// `$rewriter.wrap_get_location(location).*`, so wrap_get_location's return
// value is the interception point — no runtime location patching needed here.
//
// document.URL and document.baseURI ARE configurable own properties and CAN be
// patched, which we do so relative chunk/module loaders resolve against the
// upstream base.

import type { WrappedLocation } from "../wrappers/wrapped-location";

export function patchWindowLocation(
    targetWindow: Window,
    wrappedLocation: WrappedLocation,
    getReferer: () => string,
): void {
    // document.URL and document.baseURI must mirror the upstream href so
    // relative module/chunk loaders resolve against the upstream base, not
    // the proxy origin.
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

    // window.origin / self.origin is the frame's serialized origin — a distinct
    // own property from location.origin (which the AST rewriter already handles
    // via WrappedLocation). Under the proxy it reports the proxy origin, so any
    // same-origin comparison (`ev.origin === self.origin`) breaks. Report the
    // upstream origin instead. It's a configurable own property on window.
    try {
        Object.defineProperty(targetWindow, "origin", {
            get(): string { return wrappedLocation.origin; },
            configurable: true,
        });
    } catch { /* non-fatal */ }

    // document.domain reports the proxy hostname (localhost). Report the
    // upstream hostname. The setter is a no-op: legacy domain relaxation is
    // meaningless under a single proxy origin (all frames are already
    // same-origin), and forwarding to the native setter would throw when the
    // value isn't a suffix of the real (localhost) host.
    try {
        Object.defineProperty(targetWindow.document, "domain", {
            get(): string { return wrappedLocation.hostname; },
            set(): void { /* no-op — see above */ },
            configurable: true,
        });
    } catch { /* non-fatal */ }
}
