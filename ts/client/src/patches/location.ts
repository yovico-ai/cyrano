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

import { canonicalDomain, domainSet, isIpHost, isPublicSuffix } from "../url/document-domain";
import { documentDomains } from "../native/cross-origin";
import { stacked } from "../native/stacked";
import { ncall } from "../native/intrinsics";
import type { WrappedLocation } from "../wrappers/wrapped-location";
import { wrapAccessor } from "../native/surface";

export function patchWindowLocation(
    targetWindow: Window,
    wrappedLocation: WrappedLocation,
    unwrapOne: (url: string) => string,
    referrer?: () => string | undefined,
    base?: () => URL,
): void {
    // An about:blank / about:srcdoc document: its URL is its own (the
    // location view says so), its origin and domain its creator's.
    const baseOf = (): { origin: string; hostname: string } => base?.() ?? wrappedLocation;
    // Wrapped where each lives, found from the document itself
    // (Document.prototype in a browser).
    const doc = targetWindow.document;
    if (doc) {
        // The window's own document reads the location view; another (an
        // XHR's response document, a DOMParser's) its own URL, unwrapped
        // (round H: an XHR document read the page's URL).
        const own = (get: (this: unknown) => string, self: unknown): string =>
            self === targetWindow.document ? wrappedLocation.href : unwrapOne(ncall(get, self));
        wrapAccessor<string>(doc, "URL", { get: own });
        wrapAccessor<string>(doc, "documentURI", { get: own });
        wrapAccessor<string>(doc, "referrer", {
            get: (get, self) => { const r = referrer?.(); return typeof r === "string" ? r : unwrapOne(ncall(get, self)); },
        });
        // document.domain as HTML sets it (spec/Frames.agda domainSet): a
        // bad value throws Chromium's SecurityError, a good one becomes the
        // effective domain — the window views relax to it (relaxed:
        // native/cross-origin.ts). The native setter is never called: on the
        // proxy origin it would judge the proxy's host.
        const DE = (targetWindow as unknown as { DOMException?: new (m: string, n: string) => Error }).DOMException;
        const read = (self: unknown): string => {
            if (self !== targetWindow.document) return documentDomain(String((targetWindow as unknown as { origin?: unknown }).origin), baseOf().hostname);
            const set = documentDomains().get(targetWindow);
            return set ?? documentDomain(String((targetWindow as unknown as { origin?: unknown }).origin), baseOf().hostname);
        };
        wrapAccessor<string>(doc, "domain", {
            // An opaque origin's domain is "" (HTML document.domain).
            get: (_get, self) => read(self),
            set: (_set, self, value) => {
                if (self !== targetWindow.document || !DE) return;
                const given = String(value);
                const host = baseOf().hostname;
                const v = canonicalDomain(given);
                const r = domainSet(host, isIpHost(host), read(self), v, given === "", isPublicSuffix(v));
                const fail = (why: string): never => { throw stacked(new DE(`Failed to set the 'domain' property on 'Document': ${why}`, "SecurityError")); };
                if (r.kind === "empty") fail("'' is an empty domain.");
                if (r.kind === "tld") fail(`'${r.v}' is a top-level domain.`);
                if (r.kind === "notsuffix") fail(`'${r.v}' is not a suffix of '${r.current}'.`);
                if (r.kind === "set") documentDomains().set(targetWindow, r.v);
            },
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
    wrapAccessor<string>(targetWindow, "origin", { get: (get, self) => selfOrigin(String(ncall(get, self)), baseOf().origin) });
}

/**
 * What a document reads of its own origin, given what the native `origin`
 * reads (spec/Frames.agda selfOrigin, documentDomain): "null" there is an
 * opaque origin — the browser gives the proxied document the sandbox it
 * has direct — and then `self.origin` is "null" and `document.domain` "";
 * else the original document's origin and host.
 */
export function selfOrigin(nativeOrigin: string, original: string): string {
    return nativeOrigin === "null" ? "null" : original;
}

export function documentDomain(nativeOrigin: string, host: string): string {
    return nativeOrigin === "null" ? "" : host;
}
