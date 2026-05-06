// Patches Node.prototype.appendChild and Node.prototype.insertBefore to:
//
//   1. Rewrite URL-bearing attributes on elements being inserted — script.src,
//      link.href, iframe.src — BEFORE the append so the browser fetches the
//      proxied URL, not the upstream URL.  This catches elements created in
//      un-bootstrapped realms (cross-realm elements) whose src/href was set
//      without going through our prototype patches.
//
//   2. Inject the rewriter runtime into about:blank (and other same-origin)
//      iframes the moment they are connected to the DOM — synchronously, before
//      the caller gets control back.
//
// The server-side HTML rewriter covers <iframe> elements in static HTML by
// adding an onload="$rewriter.append_rewrite_script_into_iframe(this)" handler.
// Dynamically-created iframes (document.createElement('iframe')) never pass
// through the HTML rewriter and therefore never get that handler.
//
// Worse, some patterns (e.g. Cloudflare's beacon injection) access
// contentDocument synchronously on the very next line after appendChild —
// before any onload event fires. The only reliable interception point is
// inside appendChild itself, before it returns to the caller.

import type { ClientConfig } from "../config";
import { injectIntoIframe } from "../runtime/iframe-injection";

interface SavedOriginals {
    proto: Record<string, unknown>;
    origAppendChild: typeof Node.prototype.appendChild;
    origInsertBefore: typeof Node.prototype.insertBefore;
}
const savedByWindow = new WeakMap<Window, SavedOriginals>();

// Access window-specific constructors through a cast — TypeScript's Window
// interface doesn't declare Node/HTMLIFrameElement as instance properties even
// though browsers (and happy-dom) expose them there.
type WindowGlobals = Record<string, { prototype: Record<string, unknown> } | undefined>;

// URL-bearing attributes for each tag that we rewrite in appendChild/insertBefore.
// Keyed by nodeName (upper-case).
const URL_ATTRS_BY_TAG: Record<string, string> = {
    SCRIPT: "src",
    IFRAME: "src",
    LINK:   "href",
    IMG:    "src",
};

export function patchDynamicIframeAppend(
    targetWindow: Window,
    config: ClientConfig,
    getBaseHref: () => string,
    rewriteOne: (url: string) => string,
): void {
    if (savedByWindow.has(targetWindow)) return;

    const globals = targetWindow as unknown as WindowGlobals;
    const TargetNode = globals["Node"];
    const TargetHTMLIFrameElement = globals["HTMLIFrameElement"] as
        | (new () => HTMLIFrameElement)
        | undefined;
    if (!TargetNode?.prototype || !TargetHTMLIFrameElement) return;

    // Capture in a const so the closure below sees the narrowed (non-optional) type.
    const IFrameCtor: new () => HTMLIFrameElement = TargetHTMLIFrameElement;

    // Capture native getAttribute/setAttribute from the target window so we
    // can read/write element attributes without going through our own patches
    // (which would double-rewrite).
    const nativeGetAttr = (globals["Element"]?.prototype as { getAttribute?: (n: string) => string | null } | undefined)
        ?.getAttribute ?? Element.prototype.getAttribute;
    const nativeSetAttr = (globals["Element"]?.prototype as { setAttribute?: (n: string, v: string) => void } | undefined)
        ?.setAttribute ?? Element.prototype.setAttribute;

    const proto = TargetNode.prototype;
    const origAppendChild = proto["appendChild"] as typeof Node.prototype.appendChild;
    const origInsertBefore = proto["insertBefore"] as typeof Node.prototype.insertBefore;

    savedByWindow.set(targetWindow, { proto, origAppendChild, origInsertBefore });

    // Guard against double-injection when insertBefore(node, null) internally
    // delegates to appendChild — both patched handlers would fire for the same
    // iframe instance without this.
    const injected = new WeakSet<HTMLIFrameElement>();

    // Rewrite URL-bearing attributes on node BEFORE it is inserted into the DOM,
    // so the browser fetches the proxied URL immediately on append.
    function rewriteUrlBeforeInsert(node: Node): void {
        const tag = (node as Element).nodeName;
        const attrName = URL_ATTRS_BY_TAG[tag];
        if (!attrName) return;
        try {
            const raw = nativeGetAttr.call(node as Element, attrName);
            if (!raw) return;
            // Already proxied — nothing to do.
            if (raw.indexOf("/cyrano/") !== -1) return;
            // Only rewrite absolute URLs with a scheme we know the proxy handles.
            if (!raw.startsWith("http://") && !raw.startsWith("https://")) return;
            const rewritten = rewriteOne(raw);
            if (rewritten !== raw) {
                nativeSetAttr.call(node as Element, attrName, rewritten);
            }
        } catch {
            // Cross-realm DOM exceptions — skip; the element will load from its
            // original URL and be flagged by the MutationObserver as a miss.
        }
    }

    function maybeInjectIframe(node: Node): void {
        if (!(node instanceof IFrameCtor)) return;
        const iframe = node as HTMLIFrameElement;
        if (injected.has(iframe)) return;
        injected.add(iframe);

        // If the iframe already has a proxied src, the server will inject the
        // bootstrap when that page loads. Injecting now would stamp PATCHED_FLAG
        // onto the about:blank window; since same-origin navigations reuse the
        // window object, the bootstrap's installPatches call would be a no-op,
        // leaving DOM patches (fetch, XHR, URL attrs, document.cookie) wired to
        // this window's parent-page closure instead of the iframe's own.
        // Only inject immediately for about:blank / no-src frames (e.g. the
        // Cloudflare beacon pattern that accesses contentDocument synchronously).
        const src = iframe.src;
        if (src && src.indexOf("/cyrano/") !== -1) return;

        injectIntoIframe(iframe, targetWindow, config, getBaseHref());
    }

    proto["appendChild"] = function patchedAppendChild<T extends Node>(
        this: Node,
        node: T,
    ): T {
        rewriteUrlBeforeInsert(node);
        const result = origAppendChild.call(this, node) as T;
        maybeInjectIframe(node);
        return result;
    };

    proto["insertBefore"] = function patchedInsertBefore<T extends Node>(
        this: Node,
        node: T,
        refNode: Node | null,
    ): T {
        rewriteUrlBeforeInsert(node);
        const result = origInsertBefore.call(this, node, refNode) as T;
        maybeInjectIframe(node);
        return result;
    };
}

/** Test-only: undo the patches for a given window. */
export function unpatchDynamicIframeAppend(targetWindow: Window): void {
    const saved = savedByWindow.get(targetWindow);
    if (!saved) return;
    saved.proto["appendChild"] = saved.origAppendChild;
    saved.proto["insertBefore"] = saved.origInsertBefore;
    savedByWindow.delete(targetWindow);
}
