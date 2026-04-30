// Installs all prototype patches into a target window.
//
// Each patch is responsible for hooking one URL-bearing API at the prototype
// level so that dynamic URL assignments at runtime get routed through the
// proxy too. The server-side AST rewriter handles the things you can't
// catch any other way (location, eval, document.write, postMessage, etc.);
// these patches close the gap for everything that flows through DOM URL APIs.
//
// `installPatches` is idempotent: running it twice on the same window is a
// no-op. We mark the window with a Symbol-keyed flag so that re-bootstraps
// (e.g. after a same-document navigation) don't double-wrap natives.

import type { ClientConfig } from "../config";
import { rewriteUrl, unwrapProxiedUrl } from "../url/containment";
import { patchFetch } from "./fetch";
import { patchXmlHttpRequest } from "./xhr";
import { patchWebSocket } from "./websocket";
import { patchEventSource } from "./event-source";
import { patchWorker } from "./worker";
import { patchUrlAttributes } from "./url-attributes";
import { patchDynamicHtml } from "./dynamic-html";
import { patchCssRules } from "./css-rules";
import { patchCssStyleDeclaration } from "./css-style-declaration";
import { patchFunctionConstructor } from "./function-ctor";
import { patchDynamicIframeAppend } from "./dynamic-iframe";
import { patchHistory } from "./history";

const PATCHED_FLAG = Symbol.for("rewriter.patched");

interface PatchableWindow extends Window {
    [PATCHED_FLAG]?: boolean;
}

export function installPatches(
    targetWindow: Window,
    getCurrentBaseUrl: () => URL,
    config: ClientConfig,
): void {
    const flagged = targetWindow as PatchableWindow;
    if (flagged[PATCHED_FLAG]) return;
    flagged[PATCHED_FLAG] = true;

    const rewriteOne = (rawUrl: string): string =>
        rewriteUrl(rawUrl, getCurrentBaseUrl(), config);
    const unwrapOne = (proxiedUrl: string): string =>
        unwrapProxiedUrl(proxiedUrl, config);

    patchFetch(targetWindow, rewriteOne);
    patchXmlHttpRequest(targetWindow, rewriteOne);
    patchWebSocket(targetWindow, rewriteOne);
    patchEventSource(targetWindow, rewriteOne);
    patchWorker(targetWindow, rewriteOne);
    // Dynamic-HTML patches must come BEFORE the per-class property-setter
    // patches: dynamic-html captures Element.prototype.setAttribute as the
    // "original", and the property-setter patch later in this list works on
    // descendant constructors' descriptors which don't include setAttribute.
    patchDynamicHtml(targetWindow, rewriteOne);
    patchUrlAttributes(targetWindow, rewriteOne, unwrapOne);
    patchCssRules(targetWindow, rewriteOne);
    patchCssStyleDeclaration(targetWindow, rewriteOne);
    patchFunctionConstructor(targetWindow);
    patchDynamicIframeAppend(targetWindow, config, () => getCurrentBaseUrl().href);
    patchHistory(targetWindow, rewriteOne);
}
