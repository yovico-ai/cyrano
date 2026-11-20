// document.URL, baseURI, referrer and domain, and window.origin, as page
// code sees them natively — the original page's values.
//
// window.location itself is [LegacyUnforgeable] and cannot be redefined;
// rewritten scripts reach it through $rewriter.wrap_get_location.
//
// The document members are accessors on Document.prototype (natively not
// own properties of `document`); window.origin is an own accessor of the
// window ([Global] interface). Each keeps its native descriptor.
//
// document.referrer: natively the Referer this document was requested
// with. The server computes that header for the upstream from the original
// URLs and the referring page's policy (spec/Referrer.agda) and passes the
// same value here (config.referrer); without it, the browser's own value —
// a proxied URL — is unwrapped.

import { ncall } from "../native/intrinsics";
import type { WrappedLocation } from "../wrappers/wrapped-location";
import { wrapAccessor } from "../native/surface";

export function patchWindowLocation(
    targetWindow: Window,
    wrappedLocation: WrappedLocation,
    unwrapOne: (url: string) => string,
    referrer?: string,
    base?: () => URL,
): void {
    // An about:blank / about:srcdoc document: its URL is its own (the
    // location view says so), its origin and domain its creator's.
    const baseOf = (): { origin: string; hostname: string } => base?.() ?? wrappedLocation;
    // Wrapped where each lives, found from the document itself
    // (Document.prototype in a browser).
    const doc = targetWindow.document;
    if (doc) {
        wrapAccessor<string>(doc, "URL", { get: () => wrappedLocation.href });
        wrapAccessor<string>(doc, "documentURI", { get: () => wrappedLocation.href });
        wrapAccessor<string>(doc, "referrer", {
            get: (get, self) => (typeof referrer === "string" ? referrer : unwrapOne(ncall(get, self))),
        });
        // The setter is kept a no-op only in effect: domain relaxation is
        // meaningless when every frame already shares the proxy origin.
        wrapAccessor<string>(doc, "domain", {
            // An opaque origin's domain is "" (HTML document.domain).
            get: () => (String((targetWindow as unknown as { origin?: unknown }).origin) === "null" ? "" : baseOf().hostname),
            set: () => { /* see above */ },
        });
    }
    const N = (targetWindow as unknown as { Node?: { prototype: Node } }).Node;
    if (N?.prototype) {
        // baseURI is a Node member; for nodes of this document it is the
        // document's base URL — the original page's.
        wrapAccessor<string>(N.prototype, "baseURI", {
            get: (get, self) => unwrapOne(ncall(get, self)),
        });
    }
    // An opaque origin (a sandboxed document) reads "null", as direct: the
    // browser gives the proxied document the same sandbox.
    wrapAccessor<string>(targetWindow, "origin", { get: (get, self) => (ncall(get, self) === "null" ? "null" : baseOf().origin) });
}
