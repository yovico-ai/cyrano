// MutationObserver-based safety net + debugging layer.
//
// Two responsibilities:
//
//   1. SAFETY NET — observe URL-bearing attribute mutations on the live DOM.
//      When a non-proxied URL lands on a real element (i.e. our prototype
//      patches missed the write path), rewrite it via the native setAttribute
//      and log the miss. The observer fires as a microtask after the mutation
//      is already committed, so it can't prevent the first network request, but
//      it guarantees correctness for subsequent navigations and exposes the gap.
//
//   2. RETROACTIVE IFRAME INJECTION — on install, scan all <iframe> elements
//      that were already in the DOM before patches ran. For same-origin iframes
//      inject the rewriter runtime directly; for iframes with an unproxified
//      src URL, rewrite the src so the iframe reloads through the proxy.
//
// The miss log (getMissLog / clearMissLog) is the debugging surface: it records
// every attribute write that reached the live DOM without being caught by the
// synchronous prototype patches. In practice it should be empty on a correctly
// patched page; a non-empty log tells you which code path bypassed containment.

import { URL_BEARING_ELEMENTS } from "./url-attribute-map";
import { injectIntoIframe } from "../runtime/iframe-injection";
import { rewriteSrcsetAttribute } from "./srcset";
import type { ClientConfig } from "../config";

// Flat deduplicated list of all URL-bearing attribute names.
export const URL_ATTR_NAMES: readonly string[] = [
    ...new Set(URL_BEARING_ELEMENTS.flatMap((e) => [...e.attrs])),
];

export interface RewriteMiss {
    timestamp: number;
    tagName: string;
    attr: string;
    originalValue: string;
    rewrittenValue: string;
}

const _missLog: RewriteMiss[] = [];

export function getMissLog(): ReadonlyArray<RewriteMiss> {
    return _missLog;
}

export function clearMissLog(): void {
    _missLog.length = 0;
}

export function installMutationObserver(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
    config: ClientConfig,
    getBaseHref: () => string,
    nativeSetAttribute: typeof Element.prototype.setAttribute,
    nativeGetAttribute: typeof Element.prototype.getAttribute,
): void {
    const doc = targetWindow.document;
    if (!doc || typeof MutationObserver === "undefined") return;

    retroactivelyHandleIframes(
        doc,
        targetWindow,
        config,
        getBaseHref,
        rewriteOne,
        nativeSetAttribute,
    );

    // Rewrite all URL-bearing attributes on a newly-inserted element that
    // weren't caught by the synchronous prototype patches (e.g. because the
    // element was created and had its src set before our patches ran, or
    // because a TrustedTypes bypass was fixed post-insertion).
    // Uses nativeGetAttribute to read the raw DOM value (proxy URL), not
    // the unwrapped URL our patched getAttribute returns.
    function rewriteAddedElement(el: Element): void {
        for (const attrName of URL_ATTR_NAMES) {
            const val = nativeGetAttribute.call(el, attrName);
            if (val == null || val.length === 0) continue;
            const rewritten = attrName === "srcset"
                ? rewriteSrcsetAttribute(val, rewriteOne)
                : rewriteOne(val);
            if (rewritten === val) continue;
            _missLog.push({
                timestamp: Date.now(),
                tagName: el.tagName,
                attr: attrName,
                originalValue: val,
                rewrittenValue: rewritten,
            });
            console.warn(`[rewriter] miss (insert): ${el.tagName}.${attrName} = ${val}`);
            nativeSetAttribute.call(el, attrName, rewritten);
        }
    }

    const observer = new MutationObserver((mutations: MutationRecord[]) => {
        for (const mutation of mutations) {
            if (mutation.type === "childList") {
                // New element inserted — scan all URL-bearing attrs.  The
                // prototype patch fires synchronously on assignment, so most
                // inserts are already clean; this catches elements built
                // before patches ran or whose src was set via TrustedTypes.
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    rewriteAddedElement(node as Element);
                }
                continue;
            }
            if (mutation.type !== "attributes") continue;
            const el = mutation.target as Element;
            const attr = mutation.attributeName!;
            // Use native getAttribute to read the raw DOM value (proxy URL),
            // not the unwrapped URL that our patched getAttribute returns.
            const val = nativeGetAttribute.call(el, attr);
            if (val == null) continue;

            const rewritten =
                attr === "srcset"
                    ? rewriteSrcsetAttribute(val, rewriteOne)
                    : rewriteOne(val);
            if (rewritten === val) continue;

            _missLog.push({
                timestamp: Date.now(),
                tagName: el.tagName,
                attr,
                originalValue: val,
                rewrittenValue: rewritten,
            });
            console.warn(`[rewriter] miss: ${el.tagName}.${attr} = ${val}`);
            // Use the pre-patch native setter to avoid re-entering our patched
            // setAttribute and triggering a redundant observer mutation.
            nativeSetAttribute.call(el, attr, rewritten);
        }
    });

    const root = doc.documentElement ?? doc;
    observer.observe(root, {
        subtree: true,
        attributes: true,
        attributeFilter: [...URL_ATTR_NAMES],
        childList: true,
    });
}

function retroactivelyHandleIframes(
    doc: Document,
    parentWindow: Window,
    config: ClientConfig,
    getBaseHref: () => string,
    rewriteOne: (url: string) => string,
    nativeSetAttribute: typeof Element.prototype.setAttribute,
): void {
    let iframes: NodeListOf<HTMLIFrameElement>;
    try {
        iframes = doc.querySelectorAll<HTMLIFrameElement>("iframe");
    } catch {
        return;
    }

    for (const iframe of iframes) {
        // Inject rewriter runtime into accessible (same-origin) iframes.
        injectIntoIframe(iframe, parentWindow, config, getBaseHref());

        // If the src is an unproxified http/https URL, rewrite it so the
        // iframe reloads its content through the proxy.
        const src = iframe.getAttribute("src");
        if (src) {
            const rewritten = rewriteOne(src);
            if (rewritten !== src) {
                nativeSetAttribute.call(iframe, "src", rewritten);
            }
        }
    }
}
