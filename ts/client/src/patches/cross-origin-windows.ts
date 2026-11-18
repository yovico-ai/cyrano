// Where page code obtains other windows through native accessors, it gets
// the cross-origin view when their original origins differ
// (native/cross-origin.ts): an iframe's contentWindow (and no
// contentDocument), a message's source, opener, window.open's result; and
// frameElement is null in a frame embedded by another origin.
//
// (`parent` and `top` are unforgeable: rewritten code reaches them through
// wrappers/window-tree.ts, which applies the same view.)

import { crossOriginView } from "../native/cross-origin";
import { wrapAccessor, wrapMethod } from "../native/surface";

/**
 * The origin a frame element's document is, or is about to be, from: its
 * src as the page wrote it (the src property reads back the original URL).
 * Null when it has none or it is not an http(s) URL (about:blank, srcdoc,
 * javascript:, blob: — those are their creator's origin).
 */
function pendingOrigin(frame: unknown): string | null {
    try {
        const el = frame as HTMLIFrameElement;
        if (typeof el.hasAttribute === "function" && el.hasAttribute("srcdoc")) return null;
        const src = (el as { src?: unknown; data?: unknown }).src ?? (el as { data?: unknown }).data;
        if (typeof src !== "string" || !/^https?:/i.test(src)) return null;
        return new URL(src).origin;
    } catch {
        return null;
    }
}

export function patchCrossOriginWindows(targetWindow: Window, ensureRuntime: (frame: unknown) => void = () => undefined): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    for (const name of ["HTMLIFrameElement", "HTMLFrameElement", "HTMLObjectElement", "HTMLEmbedElement"]) {
        const proto = g[name]?.prototype;
        if (!proto) continue;
        const cw = Object.getOwnPropertyDescriptor(proto, "contentWindow")?.get as ((this: unknown) => unknown) | undefined;
        if (cw) {
            wrapAccessor<unknown>(proto, "contentWindow", {
                get: (get, self) => {
                    const w = get.call(self);
                    if (w) ensureRuntime(self);
                    return crossOriginView(w, pendingOrigin(self), targetWindow);
                },
            });
        }
        if (cw && Object.getOwnPropertyDescriptor(proto, "contentDocument")) {
            wrapAccessor<unknown>(proto, "contentDocument", {
                get: (get, self) => {
                    const w = cw.call(self);
                    if (w) ensureRuntime(self);
                    return crossOriginView(w, pendingOrigin(self), targetWindow) === w ? get.call(self) : null;
                },
            });
        }
        if (cw && "getSVGDocument" in proto) {
            wrapMethod<(...a: unknown[]) => unknown>(proto, "getSVGDocument", (native, self, args) => {
                const w = cw.call(self);
                return crossOriginView(w, null, targetWindow) === w ? Reflect.apply(native, self, args) : null;
            });
        }
    }
    const ME = g["MessageEvent"]?.prototype;
    if (ME && Object.getOwnPropertyDescriptor(ME, "source")) {
        wrapAccessor<unknown>(ME, "source", { get: (get, self) => crossOriginView(get.call(self), null, targetWindow) });
    }
    if (Object.getOwnPropertyDescriptor(targetWindow, "opener")) {
        wrapAccessor<unknown>(targetWindow, "opener", { get: (get, self) => crossOriginView(get.call(self), null, targetWindow) });
    }
    if (Object.getOwnPropertyDescriptor(targetWindow, "frameElement")) {
        wrapAccessor<unknown>(targetWindow, "frameElement", {
            get: (get, self) => {
                let parent: unknown;
                try { parent = (self as Window).parent; } catch { return null; }
                return crossOriginView(parent, null, targetWindow) === parent ? get.call(self) : null;
            },
        });
    }
}
