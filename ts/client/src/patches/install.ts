// Installs all prototype patches into a target window.
//
// Each patch is responsible for hooking one URL-bearing API at the prototype
// level so that dynamic URL assignments at runtime get routed through the
// proxy too. The server-side AST rewriter handles the things you can't
// catch any other way (location, eval, document.write, postMessage, etc.);
// these patches close the gap for everything that flows through DOM URL APIs.
//
// A window is patched once: runtime/bootstrap.ts checks before calling.

import type { Dest } from "../url/containment";
import { SafeSet, nO, nOP, nR, ncall, sStarts } from "../native/intrinsics";
import { initTrusted } from "../native/trusted";
import type { ClientConfig } from "../config";
import { rewriteUrl, unwrapProxiedUrl } from "../url/containment";
import { installToStringMask, wrapAccessor, wrapMethod } from "../native/surface";
import { patchErrorStacks } from "../native/error-stack";
import type { Internals } from "../native/internals";
import { initOriginals } from "../native/originals";
import { initCrossOrigin } from "../native/cross-origin";
import { patchCrossOriginWindows } from "./cross-origin-windows";
import { patchResponseHeaders } from "./response-headers";
import { patchEmbeddedContext } from "./embedded";
import { patchFedCM } from "./fedcm";
import { patchPaymentRequest } from "./payment-request";
import { installToolbar } from "../ui/toolbar";
import { patchSelectors } from "./selectors";
import { patchStorageNames, patchWebStorage, storagePrefix } from "./storage";
import { patchCacheUrls } from "./cache-urls";
import { patchTypedOm } from "./typed-om";
import { patchMediaMetadata } from "./media-metadata";
import { patchReflection } from "../native/hidden-globals";
import { patchDocumentWrite } from "../wrappers/document-write";
import { buildBootstrapHtml } from "../runtime/bootstrap-html";
import { patchReadBack } from "./read-back";
import { injectIntoIframe } from "../runtime/iframe-injection";
import { patchFetch } from "./fetch";
import { patchXmlHttpRequest } from "./xhr";
import { patchWebSocket } from "./websocket";
import { patchEventSource } from "./event-source";
import { patchWorker } from "./worker";
import { patchBlobWorkerSource } from "./blob-worker-source";
import { patchUrlAttributes, patchAnchorUrlReflection, patchAudioConstructor, patchFontFaceConstructor } from "./url-attributes";
import { patchDynamicHtml } from "./dynamic-html";
import { patchCssRules } from "./css-rules";
import { patchCssStyleDeclaration } from "./css-style-declaration";
import { patchFunctionConstructor } from "./function-ctor";
import { patchDynamicIframeAppend } from "./dynamic-iframe";
import { patchHistory } from "./history";
import { patchNavigation } from "./navigation";
import { patchReferrerPolicy, type RewriteOne } from "./referrer-policy";
import { patchSendBeacon } from "./beacon";
import { patchWindowOpen } from "./window-open";
import { patchServiceWorker } from "./service-worker";
import { patchDocumentCookie } from "./document-cookie";
import { patchCookieStore } from "./cookie-store";
import { patchPostMessage } from "./post-message";
import { patchMessageEventOrigin } from "./message-event";

export function installPatches(
    targetWindow: Window,
    getCurrentBaseUrl: () => URL,
    setBaseUrl: (href: string) => void,
    config: ClientConfig,
    internals: Internals,
): void {
    // Whether the browser gives this document an opaque origin (sandboxed):
    // read before location.ts wraps `origin`.
    let opaqueOrigin = false;
    try { opaqueOrigin = String((targetWindow as unknown as { origin?: unknown }).origin) === "null"; } catch { /* not opaque */ }

    // A URL a script hands over resolves against the document's base URL —
    // a <base href> where the page has one (hackage's points at another
    // host) — not the page's location. The browser keeps the base, held
    // proxied; its original is the document's base. (Read with the native
    // accessor, captured before location.ts wraps it.)
    const nodeProto = (targetWindow as unknown as { Node?: { prototype: object } }).Node?.prototype;
    const nativeBaseURI = nodeProto ? nO.getOwnPropertyDescriptor(nodeProto, "baseURI")?.get as ((this: unknown) => string) | undefined : undefined;
    const documentBase = (): URL => {
        try {
            const doc = (targetWindow as unknown as { document?: Document }).document;
            const raw = doc && nativeBaseURI ? ncall(nativeBaseURI, doc) : "";
            const original = raw ? unwrapProxiedUrl(raw, config) : raw;
            if (original && original !== raw) return new URL(original);
        } catch { /* the page's location */ }
        return getCurrentBaseUrl();
    };
    // (withPolicy: the same, for a request made under its own referrer
    // policy — the proxified URL carries it; patches/referrer-policy.ts.)
    const rewriterFor = (base: () => URL): RewriteOne => Object.assign((rawUrl: string): string =>
        rewriteUrl(rawUrl, base(), config), {
        withPolicy: (rawUrl: string, policy: string): string => rewriteUrl(rawUrl, base(), config, policy),
        withMark: (rawUrl: string, policy: string | null, dest: Dest | null): string =>
            rewriteUrl(rawUrl, base(), config, policy ?? undefined, dest ?? undefined),
        baseHref: (): string => base().href,
        withBase: (href: string): RewriteOne | null => {
            let b: URL;
            try { b = new URL(href, base()); } catch { return null; }
            return rewriterFor(() => b);
        },
    });
    const rewriteOne: RewriteOne = rewriterFor(documentBase);
    const unwrapOne = (proxiedUrl: string): string =>
        unwrapProxiedUrl(proxiedUrl, config);

    // The runtime's Trusted Types policy, before any page code (native/trusted.ts).
    initTrusted(targetWindow, config.tt);
    // First: every wrapper below reads as the native it replaces.
    installToStringMask(targetWindow as unknown as typeof globalThis);
    initCrossOrigin(targetWindow, () => getCurrentBaseUrl().origin, rewriteOne, unwrapOne);
    initOriginals(targetWindow); // captures natives: before anything wraps them
    // One patch failing must not leave the window without a runtime: in a
    // sandboxed frame (an opaque origin) natives such as
    // navigator.serviceWorker and document.cookie throw on access.
    // (config.skip, a development aid: patches left out, by name — for
    // finding which of them a site tells the runtime by.)
    const skip = new SafeSet(config.skip ?? []);
    const step = (name: string, patch: () => void): void => {
        if (skip.has(name) || skip.has("*")) return;
        try { patch(); } catch { /* that surface stays native */ }
    };
    // First: the portal toolbar keeps the natives as they are now (ui/toolbar.ts).
    const toolbarHome = config.toolbar?.home;
    if (typeof toolbarHome === "string") step("toolbar", () => installToolbar(targetWindow, toolbarHome));
    step("patchReflection", () => patchReflection(targetWindow));
    step("patchErrorStacks", () => patchErrorStacks(targetWindow, config.apiBaseURL + config.source, unwrapOne));
    step("patchPerformanceEntryNames", () => patchPerformanceEntryNames(targetWindow, unwrapOne, rewriteOne, new URL(config.apiBaseURL).origin,
        config.identity ? config.apiBaseURL + config.source : undefined));
    step("patchCspViolationEvents", () => patchCspViolationEvents(targetWindow, unwrapOne, new URL(config.apiBaseURL).origin));

    // Anchor/area URL-part reflection must be patched before patchUrlAttributes
    // wraps the href getter/setter — we need the native getter/setter to read
    // and write raw proxified values on the DOM node.
    step("patchAnchorUrlReflection", () => patchAnchorUrlReflection(targetWindow, unwrapOne, rewriteOne));
    // Requests to other origins are under CORS (patches/cors.ts).
    const cors = config.identity ? undefined
        : { origin: () => getCurrentBaseUrl().origin, href: () => getCurrentBaseUrl().href, proxy: new URL(config.apiBaseURL).origin, opaque: opaqueOrigin };
    step("patchFetch", () => patchFetch(targetWindow, rewriteOne, unwrapOne, getCurrentBaseUrl, cors));
    step("patchXmlHttpRequest", () => patchXmlHttpRequest(targetWindow, rewriteOne, unwrapOne, getCurrentBaseUrl, cors));
    step("patchWebSocket", () => patchWebSocket(targetWindow, rewriteOne, unwrapOne, () => getCurrentBaseUrl().origin));
    step("patchEventSource", () => patchEventSource(targetWindow, rewriteOne, unwrapOne));
    step("patchWorker", () => patchWorker(targetWindow, rewriteOne, patchBlobWorkerSource(targetWindow, config, getCurrentBaseUrl)));
    step("patchServiceWorker", () => patchServiceWorker(targetWindow, getCurrentBaseUrl));
    // Dynamic-HTML patches must come BEFORE the per-class property-setter
    // patches: dynamic-html captures Element.prototype.setAttribute as the
    // "original", and the property-setter patch later in this list works on
    // descendant constructors' descriptors which don't include setAttribute.
    step("patchDynamicHtml", () => patchDynamicHtml(targetWindow, rewriteOne, unwrapOne, new URL(config.apiBaseURL).origin));
    step("patchDocumentWrite", () => patchDocumentWrite(targetWindow, rewriteOne,
        () => buildBootstrapHtml(config, getCurrentBaseUrl().href), new URL(config.apiBaseURL).origin));
    step("patchUrlAttributes", () => patchUrlAttributes(targetWindow, rewriteOne, unwrapOne));
    step("patchAudioConstructor", () => patchAudioConstructor(targetWindow, rewriteOne));
    step("patchReferrerPolicy", () => patchReferrerPolicy(targetWindow, rewriteOne));
    step("patchFontFaceConstructor", () => patchFontFaceConstructor(targetWindow, rewriteOne));
    step("patchCssRules", () => patchCssRules(targetWindow, rewriteOne));
    step("patchCssStyleDeclaration", () => patchCssStyleDeclaration(targetWindow, rewriteOne));
    step("patchFunctionConstructor", () => patchFunctionConstructor(targetWindow));
    step("patchDynamicIframeAppend", () => patchDynamicIframeAppend(targetWindow, config, () => getCurrentBaseUrl().href, rewriteOne));
    step("patchHistory", () => patchHistory(targetWindow, rewriteOne, setBaseUrl, unwrapOne, getCurrentBaseUrl));
    step("patchNavigation", () => patchNavigation(targetWindow, rewriteOne, unwrapOne, setBaseUrl, config.identity ? undefined : new URL(config.apiBaseURL).origin));
    step("patchSendBeacon", () => patchSendBeacon(targetWindow, rewriteOne));
    step("patchWindowOpen", () => patchWindowOpen(targetWindow, rewriteOne));
    // (Not with the page on its own origins — config.identity: the
    // browser itself keeps the origins apart.)
    const flattened = !config.identity;
    if (flattened) step("patchPostMessage", () => patchPostMessage(targetWindow, config, unwrapOne, internals));
    if (flattened) step("patchMessageEventOrigin", () => patchMessageEventOrigin(targetWindow, config));
    // After the patches above captured the natives they call: from here page
    // code is given cross-origin views of windows of other origins.
    // … and an empty frame has the runtime by the time page code reaches into
    // it (it may do so in the same breath as creating it).
    if (flattened) step("patchCrossOriginWindows", () => patchCrossOriginWindows(targetWindow, (frame) =>
        injectIntoIframe(frame as HTMLIFrameElement, targetWindow, config, getCurrentBaseUrl().href)));
    // Selectors on URL attributes find elements by their original URLs (patches/selectors.ts).
    step("patchSelectors", () => patchSelectors(targetWindow, rewriteOne, config.apiBaseURL));
    step("patchResponseHeaders", () => patchResponseHeaders(targetWindow, opaqueOrigin));
    // FedCM requests would leave the browser outside the proxy (patches/fedcm.ts).
    step("patchFedCM", () => patchFedCM(targetWindow));
    // URL-based payment methods would have the browser fetch outside the proxy (patches/payment-request.ts).
    step("patchPaymentRequest", () => patchPaymentRequest(targetWindow));
    // What a frame of another origin's page is denied (patches/embedded.ts).
    if (flattened) step("patchEmbeddedContext", () => patchEmbeddedContext(targetWindow, () => getCurrentBaseUrl().origin));
    // Storage of every kind is this origin's alone (patches/storage.ts).
    const prefix = storagePrefix(targetWindow, () => getCurrentBaseUrl().origin);
    step("patchWebStorage", () => patchWebStorage(targetWindow, prefix, unwrapOne));
    step("patchStorageNames", () => patchStorageNames(targetWindow, prefix));
    step("patchCacheUrls", () => patchCacheUrls(targetWindow, rewriteOne));
    step("patchTypedOm", () => patchTypedOm(targetWindow, rewriteOne));
    step("patchMediaMetadata", () => patchMediaMetadata(targetWindow, rewriteOne, unwrapOne));
    // Before document.cookie is wrapped: it writes with the native setter.
    step("patchCookieStore", () => patchCookieStore(targetWindow, getCurrentBaseUrl));
    // (config.skip "cookieGet" / "cookieSet": one half only — development aid.)
    step("patchDocumentCookie", () => patchDocumentCookie(targetWindow, getCurrentBaseUrl,
        skip.has("cookieGet") ? "set" : skip.has("cookieSet") ? "get" : undefined));
    // Last: the patches above (and html-rewriter's captured natives) read
    // what elements really hold; from here on, page code reads what it wrote.
    // Every iframe gets the runtime when it loads, if its document did not
    // bring one (about:blank, srcdoc).
    const nativeListen = (targetWindow as unknown as { EventTarget?: typeof EventTarget }).EventTarget?.prototype.addEventListener;
    step("patchReadBack", () => patchReadBack(targetWindow, (el) => {
        if (el.tagName !== "IFRAME" || !nativeListen) return;
        const inject = (): void => injectIntoIframe(el as HTMLIFrameElement, targetWindow, config, getCurrentBaseUrl().href);
        ncall(nativeListen, el, "load", inject);
    }));
}

/**
 * PerformanceEntry.name: resource and navigation timing entries name the
 * URL the browser fetched — a proxied one; natively, the original. One
 * accessor on the base class covers every entry type.
 */
/** The Server-Timing metric carrying a body's original sizes (Go: server.OriginalSizesMetric). */
const SIZES_METRIC = "crnb";

/** A crnb description, "<encoded>-<decoded>" in decimal (spec/Carry.agda crnbRead), or null. */
export function crnbSizes(desc: string): { encoded: number; decoded: number } | null {
    const m = /^([0-9]+)-([0-9]+)$/.exec(desc);
    return m ? { encoded: Number(m[1]), decoded: Number(m[2]) } : null;
}

function patchPerformanceEntryNames(
    targetWindow: Window,
    unwrapOne: (url: string) => string,
    rewriteOne: (url: string) => string,
    proxyOrigin: string,
    identityRuntimeUrl?: string,
): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    const PE = g["PerformanceEntry"];
    if (!PE?.prototype) return;
    const nativeName = nO.getOwnPropertyDescriptor(PE.prototype, "name")?.get as ((this: unknown) => string) | undefined;
    wrapAccessor<string>(PE.prototype, "name", { get: (get, self) => unwrapOne(ncall(get, self)) });
    // The runtime's own requests (its script, on the proxy's origin but not
    // a proxied URL) are not the page's: no timing entry of theirs is shown.
    if (nativeName) {
        const own = (e: unknown): boolean => {
            try {
                const n = ncall(nativeName, e);
                if (identityRuntimeUrl) return n === identityRuntimeUrl;
                return sStarts(n, proxyOrigin + "/") && unwrapOne(n) === n;
            } catch {
                return false;
            }
        };
        const filtered = (native: (...a: unknown[]) => unknown, self: unknown, args: unknown[]): unknown => {
            const list = nR.apply(native, self, args) as unknown;
            return Array.isArray(list) && list.some(own) ? list.filter((e) => !own(e)) : list;
        };
        for (const holder of [g["Performance"]?.prototype, g["PerformanceObserverEntryList"]?.prototype]) {
            if (!holder) continue;
            for (const key of ["getEntries", "getEntriesByType"]) {
                if (key in holder) wrapMethod<(...a: unknown[]) => unknown>(holder, key, filtered);
            }
        }
    }
    // The protocol of the hop to the origin, not of the hop to the proxy: the
    // upstream leg speaks HTTP/2 to https origins, and a browser that reaches
    // the proxy over HTTP/1.1 would otherwise report that for every resource.
    const hop = (entry: unknown, reported: string): string => {
        if (reported !== "http/1.1" || !nativeName) return reported;
        try {
            const n = ncall(nativeName, entry);
            const original = unwrapOne(n);
            return original !== n && sStarts(original, "https:") ? "h2" : reported;
        } catch {
            return reported;
        }
    };
    for (const key of ["PerformanceResourceTiming", "PerformanceNavigationTiming"]) {
        const proto = g[key]?.prototype;
        if (proto && nO.getOwnPropertyDescriptor(proto, "nextHopProtocol")) {
            wrapAccessor<string>(proto, "nextHopProtocol", { get: (get, self) => hop(self, ncall(get, self)) });
        }
    }
    // Body sizes, as the origin sent them. The proxy rewrites documents,
    // scripts and stylesheets and decodes what it rewrites, so the browser
    // measured other bodies than the origin's; the proxy notes the origin's
    // sizes in a Server-Timing metric (Go: server.OriginalSizesMetric),
    // which the browser attaches to the entry itself. The getters answer
    // from it, and the metric is not shown. (An origin that knows what it
    // served compares: Cloudflare's challenge reports these of its own
    // frame and scripts.)
    const RT = g["PerformanceResourceTiming"]?.prototype;
    const nativeOf = <T>(key: string): ((this: unknown) => T) | undefined =>
        RT ? nO.getOwnPropertyDescriptor(RT, key)?.get as ((this: unknown) => T) | undefined : undefined;
    const nativeServerTiming = nativeOf<ReadonlyArray<{ name: string; description: string }>>("serverTiming");
    const nativeEncoded = nativeOf<number>("encodedBodySize");
    const sizesOf = (entry: unknown): { encoded: number; decoded: number } | null => {
        if (!nativeServerTiming) return null;
        try {
            for (const m of ncall(nativeServerTiming, entry)) {
                if (m.name !== SIZES_METRIC) continue;
                const sizes = crnbSizes(String(m.description));
                if (sizes) return sizes;
            }
        } catch { /* not a resource entry */ }
        return null;
    };
    /** The transfer size with the origin's body: the browser's own header overhead is kept; 0 (from cache) stays 0. */
    const transfer = (entry: unknown, reported: number): number => {
        const sizes = sizesOf(entry);
        if (!sizes || reported === 0 || !nativeEncoded) return reported;
        let measured = 0;
        try { measured = ncall(nativeEncoded, entry); } catch { return reported; }
        return sizes.encoded + Math.max(0, reported - measured);
    };
    if (RT && nativeServerTiming) {
        wrapAccessor<number>(RT, "encodedBodySize", { get: (get, self) => sizesOf(self)?.encoded ?? ncall(get, self) });
        wrapAccessor<number>(RT, "decodedBodySize", { get: (get, self) => sizesOf(self)?.decoded ?? ncall(get, self) });
        wrapAccessor<number>(RT, "transferSize", { get: (get, self) => transfer(self, ncall(get, self)) });
        wrapAccessor<ReadonlyArray<{ name: string }>>(RT, "serverTiming", {
            get: (get, self) => {
                const list = ncall(get, self);
                return list.some((m) => m.name === SIZES_METRIC) ? nO.freeze(list.filter((m) => m.name !== SIZES_METRIC)) : list;
            },
        });
    }
    // toJSON() serializes the entry's own fields: its name must be the
    // original too (Turnstile sends its script's timing entry, as JSON, to
    // Cloudflare). Subclasses define their own.
    for (const key of nO.getOwnPropertyNames(targetWindow)) {
        if (!/^Performance|^LargestContentfulPaint$|^LayoutShift$|^TaskAttributionTiming$/.test(key)) continue;
        const proto = g[key]?.prototype;
        if (!proto || !ncall(nOP.hasOwnProperty, proto, "toJSON")) continue;
        wrapMethod<(...a: unknown[]) => unknown>(proto, "toJSON", (native, self, args) => {
            const json = nR.apply(native, self, args) as Record<string, unknown> | null;
            if (json && typeof json["nextHopProtocol"] === "string") json["nextHopProtocol"] = hop(self, json["nextHopProtocol"]);
            if (json && typeof json["name"] === "string") json["name"] = unwrapOne(json["name"]);
            const sizes = json ? sizesOf(self) : null;
            if (json && sizes) {
                if (typeof json["transferSize"] === "number") json["transferSize"] = transfer(self, json["transferSize"]);
                if (typeof json["encodedBodySize"] === "number") json["encodedBodySize"] = sizes.encoded;
                if (typeof json["decodedBodySize"] === "number") json["decodedBodySize"] = sizes.decoded;
                if (Array.isArray(json["serverTiming"])) {
                    json["serverTiming"] = (json["serverTiming"] as Array<{ name?: unknown }>).filter((m) => m?.name !== SIZES_METRIC);
                }
            }
            return json;
        });
    }
    // The page asks for an entry by the URL it knows.
    const perf = g["Performance"]?.prototype;
    if (perf && "getEntriesByName" in perf) {
        wrapMethod<(...a: unknown[]) => unknown[]>(perf, "getEntriesByName", (native, self, args) => {
            const found = nR.apply(native, self, args) as unknown[];
            if (found.length || typeof args[0] !== "string") return found;
            const proxied = rewriteOne(args[0]);
            return proxied === args[0] ? found : (nR.apply(native, self, [proxied, ...args.slice(1)]) as unknown[]);
        });
    }
}

/**
 * SecurityPolicyViolationEvent: the URLs it reports are the page's own, and
 * the policy text is the origin's — without the proxy origin cyrano added
 * to its source lists (proxy/csp.go).
 */
function patchCspViolationEvents(targetWindow: Window, unwrapOne: (url: string) => string, proxyOrigin: string): void {
    const proto = (targetWindow as unknown as { SecurityPolicyViolationEvent?: { prototype: object } }).SecurityPolicyViolationEvent?.prototype;
    if (!proto) return;
    for (const key of ["documentURI", "blockedURI", "sourceFile", "referrer"]) {
        if (!nO.getOwnPropertyDescriptor(proto, key)) continue;
        wrapAccessor<string>(proto, key, { get: (get, self) => unwrapOne(ncall(get, self)) });
    }
    if (nO.getOwnPropertyDescriptor(proto, "originalPolicy")) {
        wrapAccessor<string>(proto, "originalPolicy", {
            get: (get, self) => ncall(get, self).split(" " + proxyOrigin).join(""),
        });
    }
}
