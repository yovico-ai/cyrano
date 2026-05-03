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
    const childWindow = iframe.contentWindow as WindowWithRewriter | null;
    if (!childWindow || childWindow === parentWindow) return;

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
        const parentAsRewriterHost = parentWindow as WindowWithRewriter;
        const childInit = childWindow.$rewriter_init ?? parentAsRewriterHost.$rewriter_init;
        if (typeof childInit !== "function") return;

        const childApi = childInit(childWindow, parentConfig).inject();
        childApi.set_base_url(parentBaseHref);
        childWindow.$rewriter = childApi;
    } catch {
        // Cross-origin iframes throw on `contentWindow` access. Nothing we
        // can do for those; the same-origin policy will keep them honest.
    }
}
