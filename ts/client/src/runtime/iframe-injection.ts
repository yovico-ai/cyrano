// Injects the rewriter runtime into a child iframe.
//
// For about:blank iframes (and document.write-built ones) the server can't
// pre-inject a bootstrap script — there's no upstream document for the HTML
// rewriter to munge. So the server's HTML rewriter instead emits an `onload`
// handler that calls back into the parent's $rewriter.append_rewrite_script_into_iframe(this),
// and we do the wiring here.
//
// This module is intentionally narrow: it doesn't know the shape of the
// rewriter API itself, only how to bootstrap one in a child window given a
// parent that already has $rewriter_init available.

import { unwrapProxiedUrl } from "../url/containment";
import { heldAttr } from "../native/originals";
import { contentWindowOf } from "../native/cross-origin";
import type { ClientConfig } from "../config";
import type { RewriterApi } from "./api-types";

type RewriterInit = (
    targetWindow: Window,
    config: ClientConfig,
) => { inject(): RewriterApi };

interface WindowWithRewriter extends Window {
    $rewriter?: RewriterApi;
    $rewriter_init?: RewriterInit;
}

export function injectIntoIframe(
    iframe: HTMLIFrameElement,
    parentWindow: Window,
    parentConfig: ClientConfig,
    parentBaseHref: string,
): void {
    const childWindow = contentWindowOf(iframe) as WindowWithRewriter | null; // the real window, not a view
    if (!childWindow || childWindow === parentWindow) return;
    // Only an empty frame (about:blank) is given its creator's runtime. A
    // proxied document has the server's bootstrap or, where none of its
    // scripts can run, no runtime at all — given the creator's, it read the
    // creator's URL as its own (a frame redirected back to the page's origin
    // with a document of no element: frame-redirect-back-vs-chromium). Nor
    // a blank frame on its way to a proxied URL: the navigation reuses the
    // window, and the runtime stamped on it would stay the creator's
    // (dynamic-iframe.ts maybeInjectIframe).
    try {
        if (!/^about:/i.test(String((childWindow as unknown as Window).location.href))) return;
        const src = heldAttr(iframe, "src"); // as held: getAttribute reads the page's back
        if (src && unwrapProxiedUrl(src, parentConfig) !== src) return;
    } catch { return; }

    injectIntoWindow(childWindow, parentWindow, parentConfig, parentBaseHref);
}

/**
 * Gives an empty window (a frame's, a popup's — on about:) its creator's
 * runtime: the same bundle's entry point, the creator's config, the
 * creator's URL as its base.
 */
export function injectIntoWindow(
    child: Window,
    parentWindow: Window,
    parentConfig: ClientConfig,
    parentBaseHref: string,
): void {
    const childWindow = child as WindowWithRewriter;
    try {
        // If the child already has $rewriter (the proxy injected bootstrap into
        // the iframe's HTML and it already ran), there's nothing to do. The
        // child's bootstrap set the correct base URL for the iframe's own URL;
        // overwriting it here with the parent's base URL would be wrong.
        if (childWindow.$rewriter) return;

        // Prefer the child's own $rewriter_init if it has one (it might be a
        // same-origin iframe whose document already loaded the bundle).
        // Otherwise borrow the parent's. Either way, the function is the same
        // bundle entry point.
        // The bundle's entry point: on the window that loaded it. An empty
        // frame got its runtime from its creator, so it has none of its own —
        // look up the chain of creators.
        let childInit = childWindow.$rewriter_init;
        for (let w: WindowWithRewriter | null = parentWindow as WindowWithRewriter; !childInit && w; ) {
            try { childInit = w.$rewriter_init; } catch { break; }
            let up: WindowWithRewriter | null = null;
            try { up = (w.parent !== w ? w.parent : null) as WindowWithRewriter | null; } catch { up = null; }
            w = up;
        }
        if (typeof childInit !== "function") return;

        // The child's referrer is its creator's URL, not the creator's own
        // referrer: left to the browser's value (unwrapped).
        const { referrer: _creatorsOwn, ...childConfig } = parentConfig;
        void _creatorsOwn;
        const childApi = childInit(childWindow, childConfig).inject();
        childApi.set_base_url(parentBaseHref);
        childWindow.$rewriter = childApi;
    } catch {
        // Cross-origin iframes throw on `contentWindow` access. Nothing we
        // can do for those; the same-origin policy will keep them honest.
    }
}
