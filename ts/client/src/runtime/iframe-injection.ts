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

import { srcdocReferrerFrom } from "../url/srcdoc-referrer";
import { unwrapProxiedUrl } from "../url/containment";
import { internalsOf } from "../native/internals";
import { adoptDocument } from "./bootstrap";
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

/** What a frame's window holds (spec/Frames.agda FrameDoc). */
export type FrameDoc = "pending" | "blank" | "booted" | "bare" | "inert";
/** The runtime it has for it (spec/Frames.agda frameRuntime). */
export type FrameRuntime = "none" | "creators" | "own" | "creators-own-url";

/** held: the window already holds a runtime (a creator gave it one for an earlier document). */
export function frameRuntime(held: boolean, doc: FrameDoc): FrameRuntime {
    switch (doc) {
        case "pending": case "blank": return "creators";
        case "booted": return "own";
        case "bare": return held ? "creators-own-url" : "none";
        case "inert": return "creators-own-url";
    }
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
    // with a document of no element: frame-redirect-back-vs-chromium). A
    // blank frame on its way to a proxied URL is given it too (spec/Frames.agda
    // pendingFrame): until that navigation commits, its initial about:blank
    // is what the page reaches, and what the page writes into it ran
    // without the runtime — a script's src went to its origin (Ruffle on
    // freeasteroids.org), rewritten code threw on `$rewriter`. The
    // navigation keeps the window (and realm): the document's own bootstrap
    // takes it over (runtime/bootstrap.ts adoptDocument), and one with no
    // runtime of its own is told its URL when it loads (below).
    // A frame sandboxed without scripts but same-origin (allow-same-origin):
    // its document has no runtime of its own (its URL is marked !inert:
    // spec/Frames.agda inertFrame), yet its parent scripts it — what the
    // parent writes into it, its natives, its URLs (round I: they escaped).
    // It is given its creator's runtime, told its own URL; no script of its
    // own runs, as directly.
    let doc: FrameDoc;
    let here = "";
    const held = internalsOf(childWindow);
    try {
        here = String((childWindow as unknown as Window).location.href);
        doc = /\/cyrano\/[^/]*!inert(?=[!/])/.test(here) ? "inert"
            : /^about:/i.test(here) ? "pending"
            // A document of its own: its bootstrap took the window over
            // (adoptDocument noted its document), or it has none.
            : held && held.doc === childWindow.document ? "booted" : "bare";
    } catch { return; }
    const rt = frameRuntime(held !== undefined, doc);
    if (rt === "none" || rt === "own") return;
    if (rt === "creators-own-url") {
        const own = unwrapProxiedUrl(here, parentConfig);
        if (held) adoptDocument(childWindow, held);
        else injectIntoWindow(childWindow, parentWindow, parentConfig, own);
        try { (childWindow.$rewriter as unknown as { set_location?: (u: string) => void } | undefined)?.set_location?.(own); } catch { /* as it is */ }
        return;
    }

    // A srcdoc frame keeps this Window when its about:srcdoc document
    // replaces the initial about:blank (same origin): its referrer is the
    // srcdoc's (spec srcdocReferrer), given here — its own bootstrap then
    // finds the runtime already in place.
    let referrer: string | null | undefined;
    try { if (iframe.hasAttribute("srcdoc")) referrer = srcdocReferrerFrom(parentWindow, parentConfig as { rp?: unknown }); } catch { referrer = undefined; }
    injectIntoWindow(childWindow, parentWindow, parentConfig, parentBaseHref, referrer);
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
    srcdocRef?: string | null,
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
        // The copy the creator runs first (native/internals.ts init).
        let childInit = internalsOf(parentWindow)?.init as RewriterInit | undefined ?? childWindow.$rewriter_init;
        for (let w: WindowWithRewriter | null = parentWindow as WindowWithRewriter; !childInit && w; ) {
            try { childInit = w.$rewriter_init; } catch { break; }
            let up: WindowWithRewriter | null = null;
            try { up = (w.parent !== w ? w.parent : null) as WindowWithRewriter | null; } catch { up = null; }
            w = up;
        }
        if (typeof childInit !== "function") return;

        // The child's referrer is its creator's URL, not the creator's own
        // referrer: left to the browser's value (unwrapped).
        const { referrer: _creatorsOwn, ...rest } = parentConfig;
        void _creatorsOwn;
        const childConfig = srcdocRef === undefined ? rest : { ...rest, referrer: srcdocRef ?? "" };
        const childApi = childInit(childWindow, childConfig).inject();
        childApi.set_base_url(parentBaseHref);
        childWindow.$rewriter = childApi;
    } catch {
        // Cross-origin iframes throw on `contentWindow` access. Nothing we
        // can do for those; the same-origin policy will keep them honest.
    }
}
