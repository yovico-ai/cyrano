// Installs all prototype patches into a target window.
//
// Each patch is responsible for hooking one URL-bearing API at the prototype
// level so that dynamic URL assignments at runtime get routed through the
// proxy too. The server-side AST rewriter handles the things you can't
// catch any other way (location, eval, document.write, postMessage, etc.);
// these patches close the gap for everything that flows through DOM URL APIs.
//
// A window is patched once: runtime/bootstrap.ts checks before calling.

import type { ClientConfig } from "../config";
import { rewriteUrl, unwrapProxiedUrl } from "../url/containment";
import { installToStringMask, wrapAccessor } from "../native/surface";
import { patchErrorStacks } from "../native/error-stack";
import type { Internals } from "../native/internals";
import { initOriginals } from "../native/originals";
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

    // First: every wrapper below reads as the native it replaces.
    installToStringMask(targetWindow as unknown as typeof globalThis);
    initOriginals(targetWindow); // captures natives: before anything wraps them
    patchErrorStacks(targetWindow, config.apiBaseURL + config.source, unwrapOne);
    patchPerformanceEntryNames(targetWindow, unwrapOne);

    // Anchor/area URL-part reflection must be patched before patchUrlAttributes
    // wraps the href getter/setter — we need the native getter/setter to read
    // and write raw proxified values on the DOM node.
    patchAnchorUrlReflection(targetWindow, unwrapOne, rewriteOne);
    patchFetch(targetWindow, rewriteOne, unwrapOne, getCurrentBaseUrl);
    patchXmlHttpRequest(targetWindow, rewriteOne, unwrapOne);
    patchWebSocket(targetWindow, rewriteOne, unwrapOne, () => getCurrentBaseUrl().origin);
    patchEventSource(targetWindow, rewriteOne, unwrapOne);
    patchWorker(targetWindow, rewriteOne, patchBlobWorkerSource(targetWindow, config, getCurrentBaseUrl));
    patchServiceWorker(targetWindow);
    // Dynamic-HTML patches must come BEFORE the per-class property-setter
    // patches: dynamic-html captures Element.prototype.setAttribute as the
    // "original", and the property-setter patch later in this list works on
    // descendant constructors' descriptors which don't include setAttribute.
    patchDynamicHtml(targetWindow, rewriteOne, unwrapOne);
    patchUrlAttributes(targetWindow, rewriteOne, unwrapOne);
    patchCssRules(targetWindow, rewriteOne);
    patchCssStyleDeclaration(targetWindow, rewriteOne);
    patchFunctionConstructor(targetWindow);
    patchDynamicIframeAppend(targetWindow, config, () => getCurrentBaseUrl().href, rewriteOne);
    patchHistory(targetWindow, rewriteOne, setBaseUrl, unwrapOne, getCurrentBaseUrl);
    patchSendBeacon(targetWindow, rewriteOne);
    patchWindowOpen(targetWindow, rewriteOne);
    patchPostMessage(targetWindow, config, unwrapOne, internals);
    patchMessageEventOrigin(targetWindow, config);
    patchDocumentCookie(targetWindow, getCurrentBaseUrl);
    // Last: the patches above (and html-rewriter's captured natives) read
    // what elements really hold; from here on, page code reads what it wrote.
    // Every iframe gets the runtime when it loads, if its document did not
    // bring one (about:blank, srcdoc).
    const nativeListen = (targetWindow as unknown as { EventTarget?: typeof EventTarget }).EventTarget?.prototype.addEventListener;
    patchReadBack(targetWindow, (el) => {
        if (el.tagName !== "IFRAME" || !nativeListen) return;
        const inject = (): void => injectIntoIframe(el as HTMLIFrameElement, targetWindow, config, getCurrentBaseUrl().href);
        nativeListen.call(el, "load", inject);
    });
}

/**
 * PerformanceEntry.name: resource and navigation timing entries name the
 * URL the browser fetched — a proxied one; natively, the original. One
 * accessor on the base class covers every entry type.
 */
function patchPerformanceEntryNames(targetWindow: Window, unwrapOne: (url: string) => string): void {
    const PE = (targetWindow as unknown as { PerformanceEntry?: { prototype: PerformanceEntry } }).PerformanceEntry;
    if (!PE?.prototype) return;
    wrapAccessor<string>(PE.prototype, "name", { get: (get, self) => unwrapOne(get.call(self)) });
}
