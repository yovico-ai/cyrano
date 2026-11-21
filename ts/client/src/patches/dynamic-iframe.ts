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

import { SafeWeakMap, nO, nOP, nR, ncall } from "../native/intrinsics";
import type { ClientConfig } from "../config";
import { replaceValue, wrapMethod } from "../native/surface";
import { unwrapProxiedUrl } from "../url/containment";
import { injectIntoIframe } from "../runtime/iframe-injection";
import { rawTextTarget, rewriteTextNode } from "./dynamic-html";
import { rewriteSrcsetAttribute } from "./srcset";
import { kindOf, rewriteByKind, urlAttrsOf } from "./url-attribute-map";
import { originalAttr, recordAttr } from "../native/originals";

interface SavedOriginals {
    proto: Record<string, unknown>;
    origAppendChild: typeof Node.prototype.appendChild;
    origInsertBefore: typeof Node.prototype.insertBefore;
}
const savedByWindow = new SafeWeakMap<Window, SavedOriginals>();

// Access window-specific constructors through a cast — TypeScript's Window
// interface doesn't declare Node/HTMLIFrameElement as instance properties even
// though browsers (and happy-dom) expose them there.
type WindowGlobals = Record<string, { prototype: Record<string, unknown> } | undefined>;

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

    // An element whose URL attributes reached it by a route no setter saw
    // (an attribute node's value, a tree from another document) still
    // holds the page's URLs: they are proxified before the browser fetches
    // them on insertion — by the spec's table (spec/Attrs.agda), the page's
    // value recorded so it reads back. A tree from another document is
    // walked whole; one of this document's, only its root (its own
    // descendants went through the setters).
    const fixElement = (el: Element): void => {
        for (const name of urlAttrsOf(el)) {
            if (originalAttr(el, name) !== undefined) continue; // the runtime's already
            const raw = ncall(nativeGetAttr, el, name) as string | null;
            if (!raw) continue;
            const rewritten = rewriteByKind(kindOf(el, name), raw, rewriteOne, rewriteSrcsetAttribute);
            if (rewritten === raw) continue;
            ncall(nativeSetAttr, el, name, rewritten);
            recordAttr(el, name, rewritten, raw);
        }
    };
    function rewriteUrlBeforeInsert(node: Node): void {
        try {
            if (node.nodeType === 1) fixElement(node as Element);
            const foreign = node.ownerDocument !== null && node.ownerDocument !== targetWindow.document;
            const q = (node as { querySelectorAll?: (s: string) => ArrayLike<Element> }).querySelectorAll;
            if ((foreign || node.nodeType === 11) && typeof q === "function" && node.firstChild) {
                const all = ncall(q, node, "*") as ArrayLike<Element>;
                for (let i = 0; i < all.length; i++) fixElement(all[i]!);
            }
        } catch {
            // Cross-realm DOM exceptions: the element loads as it is.
        }
    }

    function maybeInjectIframe(node: Node): void {
        if (!(node instanceof IFrameCtor)) return;
        const iframe = node as HTMLIFrameElement;
        // A frame inserted again has a new window: no memo by element
        // (injectIntoIframe leaves a window that has the runtime alone).

        // If the iframe already has a proxied src, the server will inject the
        // bootstrap when that page loads. Injecting now would stamp PATCHED_FLAG
        // onto the about:blank window; since same-origin navigations reuse the
        // window object, the bootstrap's installPatches call would be a no-op,
        // leaving DOM patches (fetch, XHR, URL attrs, document.cookie) wired to
        // this window's parent-page closure instead of the iframe's own.
        // Only inject immediately for about:blank / no-src frames (e.g. the
        // Cloudflare beacon pattern that accesses contentDocument synchronously).
        // The raw attribute (iframe.src itself reads back the original URL).
        const src = ncall(nativeGetAttr, iframe, "src");
        if (src && unwrapProxiedUrl(src, config) !== src) return;

        injectIntoIframe(iframe, targetWindow, config, getBaseHref());
    }

    // Every frame in what was inserted gets the runtime as it is connected:
    // page code may reach its document straight away, by any route
    // (window.frames[name] included, which no getter sees).
    const framesIn = (node: unknown): Node[] => {
        if (!(node instanceof Object)) return [];
        const n = node as Node & { querySelectorAll?: (s: string) => ArrayLike<Node> };
        const out: Node[] = n instanceof IFrameCtor ? [n] : [];
        if (typeof n.querySelectorAll === "function" && n.firstChild) {
            const inner = n.querySelectorAll("iframe");
            for (let i = 0; i < inner.length; i++) out.push(inner[i]!);
        }
        return out;
    };
    const injectAll = (frames: Node[]): void => {
        for (const f of frames) if ((f as Node).isConnected) maybeInjectIframe(f);
    };
    // One insertion may run through another (insertBefore(n, null) as
    // appendChild in some DOMs): the outermost call injects.
    let depth = 0;
    const inserting = <T>(frames: Node[], run: () => T): T => {
        depth++;
        let result: T;
        try { result = run(); } finally { depth--; }
        if (depth === 0) injectAll(frames);
        return result;
    };
    frameInjectors.set(targetWindow, (root) => injectAll(framesIn(root)));

    for (const key of ["appendChild", "insertBefore", "replaceChild"] as const) {
        wrapMethod<(...a: unknown[]) => Node>(proto, key, (native, self, args) => {
            const node = args[0];
            // A text node headed into a <script> or <style>: its JS or CSS.
            const parent = self as Element | null;
            if (key !== "replaceChild" && parent && (parent.tagName === "SCRIPT" || parent.tagName === "STYLE")) rewriteTextNode(parent, node, rewriteOne);
            if (node instanceof Object) rewriteUrlBeforeInsert(node as Node);
            // A fragment is empty once inserted: its frames are found first.
            return inserting(framesIn(node), () => nR.apply(native, self, args) as Node);
        });
    }
    // The ParentNode / ChildNode methods and insertAdjacentElement insert
    // nodes too: their frames get the runtime the same way.
    const nodeArgs: Record<string, (args: unknown[]) => unknown[]> = {
        append: (a) => a, prepend: (a) => a, before: (a) => a, after: (a) => a,
        replaceWith: (a) => a, replaceChildren: (a) => a, insertAdjacentElement: (a) => [a[1]],
        moveBefore: (a) => [a[0]],
    };
    for (const holderName of ["Element", "Document", "DocumentFragment", "CharacterData", "DocumentType"]) {
        const holder = globals[holderName]?.prototype as object | undefined;
        if (!holder) continue;
        for (const [key, nodesOf] of nO.entries(nodeArgs)) {
            if (!ncall(nOP.hasOwnProperty, holder, key)) continue;
            wrapMethod<(...a: unknown[]) => unknown>(holder, key, (native, self, args) => {
                // Text (strings, text nodes, fragments) put into a <script>
                // or <style>: its JS or CSS.
                const raw = key === "insertAdjacentElement" || key === "moveBefore" ? null : rawTextTarget(self, key);
                if (raw) args = args.map((a) => rewriteTextNode(raw, a, rewriteOne));
                const frames: Node[] = [];
                for (const n of nodesOf(args)) {
                    if (n instanceof Object) rewriteUrlBeforeInsert(n as Node);
                    frames.push(...framesIn(n));
                }
                return inserting(frames, () => nR.apply(native, self, args));
            });
        }
    }
}

const frameInjectors = new SafeWeakMap<object, (root: unknown) => void>();

/**
 * Gives the runtime to the empty frames in `root`, which markup was just
 * parsed into (innerHTML, insertAdjacentHTML, document.write, …), with the
 * runtime of `targetWindow` — the window whose patch did the parsing.
 */
export function injectFramesIn(targetWindow: Window, root: unknown): void {
    try { frameInjectors.get(targetWindow)?.(root); } catch { /* the page's call must not fail for it */ }
}

/** Test-only: undo the patches for a given window. */
export function unpatchDynamicIframeAppend(targetWindow: Window): void {
    const saved = savedByWindow.get(targetWindow);
    if (!saved) return;
    replaceValue(saved.proto, "appendChild", saved.origAppendChild);
    replaceValue(saved.proto, "insertBefore", saved.origInsertBefore);
    savedByWindow.delete(targetWindow);
}
