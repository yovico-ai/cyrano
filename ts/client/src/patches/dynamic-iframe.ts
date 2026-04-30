// Patches Node.prototype.appendChild and Node.prototype.insertBefore to inject
// the rewriter runtime into about:blank (and other same-origin) iframes the
// moment they are connected to the DOM — synchronously, before the caller gets
// control back.
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

export function patchDynamicIframeAppend(
    targetWindow: Window,
    config: ClientConfig,
    getBaseHref: () => string,
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
    const proto = TargetNode.prototype;
    const origAppendChild = proto["appendChild"] as typeof Node.prototype.appendChild;
    const origInsertBefore = proto["insertBefore"] as typeof Node.prototype.insertBefore;

    savedByWindow.set(targetWindow, { proto, origAppendChild, origInsertBefore });

    // Guard against double-injection when insertBefore(node, null) internally
    // delegates to appendChild — both patched handlers would fire for the same
    // iframe instance without this.
    const injected = new WeakSet<HTMLIFrameElement>();

    function maybeInject(node: Node): void {
        if (!(node instanceof IFrameCtor)) return;
        const iframe = node as HTMLIFrameElement;
        if (injected.has(iframe)) return;
        injected.add(iframe);
        injectIntoIframe(iframe, targetWindow, config, getBaseHref());
    }

    proto["appendChild"] = function patchedAppendChild<T extends Node>(
        this: Node,
        node: T,
    ): T {
        const result = origAppendChild.call(this, node) as T;
        maybeInject(node);
        return result;
    };

    proto["insertBefore"] = function patchedInsertBefore<T extends Node>(
        this: Node,
        node: T,
        refNode: Node | null,
    ): T {
        const result = origInsertBefore.call(this, node, refNode) as T;
        maybeInject(node);
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
