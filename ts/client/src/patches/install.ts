// Installs all prototype patches into a target window.
//
// Each patch is responsible for hooking one URL-bearing API at the prototype
// level so that dynamic URL assignments at runtime get routed through the
// proxy too. The server-side AST rewriter handles the things you can't
// catch any other way (location, eval, document.write, postMessage, etc.);
// these patches close the gap for everything that flows through DOM URL APIs.
//
// A window is patched once: runtime/bootstrap.ts checks before calling.

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
import { patchStorageNames, patchWebStorage, storagePrefix } from "./storage";
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
import { patchUrlAttributes, patchAnchorUrlReflection } from "./url-attributes";
import { patchDynamicHtml } from "./dynamic-html";
import { patchCssRules } from "./css-rules";
import { patchCssStyleDeclaration } from "./css-style-declaration";
import { patchFunctionConstructor } from "./function-ctor";
import { patchDynamicIframeAppend } from "./dynamic-iframe";
import { patchHistory } from "./history";
import { patchSendBeacon } from "./beacon";
import { patchWindowOpen } from "./window-open";
import { patchServiceWorker } from "./service-worker";
import { patchDocumentCookie } from "./document-cookie";
import { patchPostMessage } from "./post-message";
import { patchMessageEventOrigin } from "./message-event";

export function installPatches(
    targetWindow: Window,
    getCurrentBaseUrl: () => URL,
    setBaseUrl: (href: string) => void,
    config: ClientConfig,
    internals: Internals,
): void {

    const rewriteOne = (rawUrl: string): string =>
        rewriteUrl(rawUrl, getCurrentBaseUrl(), config);
    const unwrapOne = (proxiedUrl: string): string =>
        unwrapProxiedUrl(proxiedUrl, config);

    // The runtime's Trusted Types policy, before any page code (native/trusted.ts).
    initTrusted(targetWindow, config.tt);
    // First: every wrapper below reads as the native it replaces.
    installToStringMask(targetWindow as unknown as typeof globalThis);
    initCrossOrigin(targetWindow, () => getCurrentBaseUrl().origin, rewriteOne);
    initOriginals(targetWindow); // captures natives: before anything wraps them
    // One patch failing must not leave the window without a runtime: in a
    // sandboxed frame (an opaque origin) natives such as
    // navigator.serviceWorker and document.cookie throw on access.
    // (config.skip, a development aid: patches left out, by name — for
    // finding which of them a site tells the runtime by.)
    const skip = new Set(config.skip ?? []);
    const step = (name: string, patch: () => void): void => {
        if (skip.has(name) || skip.has("*")) return;
        try { patch(); } catch { /* that surface stays native */ }
    };
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
    const cors = config.identity ? undefined : { origin: () => getCurrentBaseUrl().origin, href: () => getCurrentBaseUrl().href };
    step("patchFetch", () => patchFetch(targetWindow, rewriteOne, unwrapOne, getCurrentBaseUrl, cors));
    step("patchXmlHttpRequest", () => patchXmlHttpRequest(targetWindow, rewriteOne, unwrapOne, getCurrentBaseUrl, cors));
    step("patchWebSocket", () => patchWebSocket(targetWindow, rewriteOne, unwrapOne, () => getCurrentBaseUrl().origin));
    step("patchEventSource", () => patchEventSource(targetWindow, rewriteOne, unwrapOne));
    step("patchWorker", () => patchWorker(targetWindow, rewriteOne, patchBlobWorkerSource(targetWindow, config, getCurrentBaseUrl)));
    step("patchServiceWorker", () => patchServiceWorker(targetWindow));
    // Dynamic-HTML patches must come BEFORE the per-class property-setter
    // patches: dynamic-html captures Element.prototype.setAttribute as the
    // "original", and the property-setter patch later in this list works on
    // descendant constructors' descriptors which don't include setAttribute.
    step("patchDynamicHtml", () => patchDynamicHtml(targetWindow, rewriteOne, unwrapOne));
    step("patchDocumentWrite", () => patchDocumentWrite(targetWindow, rewriteOne,
        () => buildBootstrapHtml(config, getCurrentBaseUrl().href), new URL(config.apiBaseURL).origin));
    step("patchUrlAttributes", () => patchUrlAttributes(targetWindow, rewriteOne, unwrapOne));
    step("patchCssRules", () => patchCssRules(targetWindow, rewriteOne));
    step("patchCssStyleDeclaration", () => patchCssStyleDeclaration(targetWindow, rewriteOne));
    step("patchFunctionConstructor", () => patchFunctionConstructor(targetWindow));
    step("patchDynamicIframeAppend", () => patchDynamicIframeAppend(targetWindow, config, () => getCurrentBaseUrl().href, rewriteOne));
    step("patchHistory", () => patchHistory(targetWindow, rewriteOne, setBaseUrl, unwrapOne, getCurrentBaseUrl));
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
    step("patchResponseHeaders", () => patchResponseHeaders(targetWindow));
    // What a frame of another origin's page is denied (patches/embedded.ts).
    if (flattened) step("patchEmbeddedContext", () => patchEmbeddedContext(targetWindow, () => getCurrentBaseUrl().origin));
    // Storage of every kind is this origin's alone (patches/storage.ts).
    const prefix = storagePrefix(targetWindow, () => getCurrentBaseUrl().origin);
    step("patchWebStorage", () => patchWebStorage(targetWindow, prefix, unwrapOne));
    step("patchStorageNames", () => patchStorageNames(targetWindow, prefix));
    step("patchDocumentCookie", () => patchDocumentCookie(targetWindow, getCurrentBaseUrl));
    // Last: the patches above (and html-rewriter's captured natives) read
    // what elements really hold; from here on, page code reads what it wrote.
    // Every iframe gets the runtime when it loads, if its document did not
    // bring one (about:blank, srcdoc).
    const nativeListen = (targetWindow as unknown as { EventTarget?: typeof EventTarget }).EventTarget?.prototype.addEventListener;
    step("patchReadBack", () => patchReadBack(targetWindow, (el) => {
        if (el.tagName !== "IFRAME" || !nativeListen) return;
        const inject = (): void => injectIntoIframe(el as HTMLIFrameElement, targetWindow, config, getCurrentBaseUrl().href);
        nativeListen.call(el, "load", inject);
    }));
}

/**
 * PerformanceEntry.name: resource and navigation timing entries name the
 * URL the browser fetched — a proxied one; natively, the original. One
 * accessor on the base class covers every entry type.
 */
/** The Server-Timing metric carrying a body's original sizes (Go: server.OriginalSizesMetric). */
const SIZES_METRIC = "crnb";

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
    const nativeName = Object.getOwnPropertyDescriptor(PE.prototype, "name")?.get as ((this: unknown) => string) | undefined;
    wrapAccessor<string>(PE.prototype, "name", { get: (get, self) => unwrapOne(get.call(self)) });
    // The runtime's own requests (its script, on the proxy's origin but not
    // a proxied URL) are not the page's: no timing entry of theirs is shown.
    if (nativeName) {
        const own = (e: unknown): boolean => {
            try {
                const n = nativeName.call(e);
                if (identityRuntimeUrl) return n === identityRuntimeUrl;
                return n.startsWith(proxyOrigin + "/") && unwrapOne(n) === n;
            } catch {
                return false;
            }
        };
        const filtered = (native: (...a: unknown[]) => unknown, self: unknown, args: unknown[]): unknown => {
            const list = Reflect.apply(native, self, args) as unknown;
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
            const n = nativeName.call(entry);
            const original = unwrapOne(n);
            return original !== n && original.startsWith("https:") ? "h2" : reported;
        } catch {
            return reported;
        }
    };
    for (const key of ["PerformanceResourceTiming", "PerformanceNavigationTiming"]) {
        const proto = g[key]?.prototype;
        if (proto && Object.getOwnPropertyDescriptor(proto, "nextHopProtocol")) {
            wrapAccessor<string>(proto, "nextHopProtocol", { get: (get, self) => hop(self, get.call(self)) });
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
        RT ? Object.getOwnPropertyDescriptor(RT, key)?.get as ((this: unknown) => T) | undefined : undefined;
    const nativeServerTiming = nativeOf<ReadonlyArray<{ name: string; description: string }>>("serverTiming");
    const nativeEncoded = nativeOf<number>("encodedBodySize");
    const sizesOf = (entry: unknown): { encoded: number; decoded: number } | null => {
        if (!nativeServerTiming) return null;
        try {
            for (const m of nativeServerTiming.call(entry)) {
                if (m.name !== SIZES_METRIC) continue;
                const [encoded, decoded] = String(m.description).split("-").map(Number);
                if (Number.isFinite(encoded) && Number.isFinite(decoded)) return { encoded: encoded!, decoded: decoded! };
            }
        } catch { /* not a resource entry */ }
        return null;
    };
    /** The transfer size with the origin's body: the browser's own header overhead is kept; 0 (from cache) stays 0. */
    const transfer = (entry: unknown, reported: number): number => {
        const sizes = sizesOf(entry);
        if (!sizes || reported === 0 || !nativeEncoded) return reported;
        let measured = 0;
        try { measured = nativeEncoded.call(entry); } catch { return reported; }
        return sizes.encoded + Math.max(0, reported - measured);
    };
    if (RT && nativeServerTiming) {
        wrapAccessor<number>(RT, "encodedBodySize", { get: (get, self) => sizesOf(self)?.encoded ?? get.call(self) });
        wrapAccessor<number>(RT, "decodedBodySize", { get: (get, self) => sizesOf(self)?.decoded ?? get.call(self) });
        wrapAccessor<number>(RT, "transferSize", { get: (get, self) => transfer(self, get.call(self)) });
        wrapAccessor<ReadonlyArray<{ name: string }>>(RT, "serverTiming", {
            get: (get, self) => {
                const list = get.call(self);
                return list.some((m) => m.name === SIZES_METRIC) ? Object.freeze(list.filter((m) => m.name !== SIZES_METRIC)) : list;
            },
        });
    }
    // toJSON() serializes the entry's own fields: its name must be the
    // original too (Turnstile sends its script's timing entry, as JSON, to
    // Cloudflare). Subclasses define their own.
    for (const key of Object.getOwnPropertyNames(targetWindow)) {
        if (!/^Performance|^LargestContentfulPaint$|^LayoutShift$|^TaskAttributionTiming$/.test(key)) continue;
        const proto = g[key]?.prototype;
        if (!proto || !Object.prototype.hasOwnProperty.call(proto, "toJSON")) continue;
        wrapMethod<(...a: unknown[]) => unknown>(proto, "toJSON", (native, self, args) => {
            const json = Reflect.apply(native, self, args) as Record<string, unknown> | null;
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
            const found = Reflect.apply(native, self, args) as unknown[];
            if (found.length || typeof args[0] !== "string") return found;
            const proxied = rewriteOne(args[0]);
            return proxied === args[0] ? found : (Reflect.apply(native, self, [proxied, ...args.slice(1)]) as unknown[]);
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
        if (!Object.getOwnPropertyDescriptor(proto, key)) continue;
        wrapAccessor<string>(proto, key, { get: (get, self) => unwrapOne(get.call(self)) });
    }
    if (Object.getOwnPropertyDescriptor(proto, "originalPolicy")) {
        wrapAccessor<string>(proto, "originalPolicy", {
            get: (get, self) => get.call(self).split(" " + proxyOrigin).join(""),
        });
    }
}
