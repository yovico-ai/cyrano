// Where page code obtains other windows through native accessors, it gets
// the cross-origin view when their original origins differ
// (native/cross-origin.ts): an iframe's contentWindow (and no
// contentDocument), a message's source, opener, window.open's result; and
// frameElement is null in a frame embedded by another origin.
//
// (`parent` and `top` are unforgeable: rewritten code reaches them through
// wrappers/window-tree.ts, which applies the same view.)

import { SafeMap, nO, nR, ncall } from "../native/intrinsics";
import { hideOwn, showOwn } from "../native/hidden-globals";
import { onInserted } from "./dynamic-iframe";
import { coopSevered, crossOriginView } from "../native/cross-origin";
import { wrapAccessor, wrapMethod } from "../native/surface";

/**
 * The origin a frame element's document is, or is about to be, from: its
 * src as the page wrote it (the src property reads back the original URL).
 * Null when it has none or it is not an http(s) URL (about:blank, srcdoc,
 * javascript:, blob: — those are their creator's origin; data: is opaque,
 * kept cross-origin by the browser itself). spec/Frames.agda frameOrigin.
 */
export function pendingOrigin(frame: unknown): string | null {
    try {
        const el = frame as HTMLIFrameElement;
        // srcdoc is an iframe's (an <object srcdoc> is nothing)
        if ("srcdoc" in (el as object) && typeof el.hasAttribute === "function" && el.hasAttribute("srcdoc")) return null;
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
        const cw = nO.getOwnPropertyDescriptor(proto, "contentWindow")?.get as ((this: unknown) => unknown) | undefined;
        if (cw) {
            wrapAccessor<unknown>(proto, "contentWindow", {
                get: (get, self) => {
                    const w = ncall(get, self);
                    if (w) ensureRuntime(self);
                    return crossOriginView(w, pendingOrigin(self), targetWindow);
                },
            });
        }
        if (cw && nO.getOwnPropertyDescriptor(proto, "contentDocument")) {
            wrapAccessor<unknown>(proto, "contentDocument", {
                get: (get, self) => {
                    const w = ncall(cw, self);
                    if (w) ensureRuntime(self);
                    return crossOriginView(w, pendingOrigin(self), targetWindow) === w ? ncall(get, self) : null;
                },
            });
        }
        if (cw && "getSVGDocument" in proto) {
            wrapMethod<(...a: unknown[]) => unknown>(proto, "getSVGDocument", (native, self, args) => {
                const w = ncall(cw, self);
                return crossOriginView(w, null, targetWindow) === w ? nR.apply(native, self, args) : null;
            });
        }
    }
    const ME = g["MessageEvent"]?.prototype;
    if (ME && nO.getOwnPropertyDescriptor(ME, "source")) {
        wrapAccessor<unknown>(ME, "source", { get: (get, self) => crossOriginView(ncall(get, self), null, targetWindow) });
    }
    if (nO.getOwnPropertyDescriptor(targetWindow, "opener")) {
        // (a popup severed from its opener by an emulated group switch has none: spec/Coop.agda)
        wrapAccessor<unknown>(targetWindow, "opener", { get: (get, self) => (coopSevered().has(self as object) ? null : crossOriginView(ncall(get, self), null, targetWindow)) });
    }
    if (nO.getOwnPropertyDescriptor(targetWindow, "frameElement")) {
        wrapAccessor<unknown>(targetWindow, "frameElement", {
            get: (get, self) => {
                let parent: unknown;
                try { parent = (self as Window).parent; } catch { return null; }
                return crossOriginView(parent, null, targetWindow) === parent ? ncall(get, self) : null;
            },
        });
    }
}

/**
 * A child frame reached by name (`window.kid`, a bare `kid`, `self["kid"]`)
 * comes off the window's named properties object (WindowProperties), which
 * handed page code the raw window of a frame of another origin — its
 * document readable, natively a SecurityError — and an object unequal to
 * `frames[0]`. Chromium gives Window.prototype and WindowProperties
 * immutable prototypes and refuses definitions on the latter, so the view
 * is one step earlier in the chain: an accessor on Window.prototype for
 * each child's name (none where Window.prototype has a member of that name,
 * which natively wins), reading what the named object gives and showing it
 * as crossOriginView does; a write makes the receiver's own property, as
 * natively. The accessors are hidden from reflection (hidden-globals.ts) and
 * kept in step with the frames: at every insertion, frame load, name
 * attribute change. Limit: a child renaming itself (`window.name = …`)
 * shows by its new name at the next of those.
 */
export function patchNamedFrames(targetWindow: Window): void {
    const W = (targetWindow as unknown as { Window?: { prototype: object } }).Window;
    if (!W) return;
    const proto = W.prototype;
    const named = nO.getPrototypeOf(proto) as object | null;
    if (!named) return;
    const mine = new SafeMap<string, true>();
    // A frame's window is judged as its element's contentWindow is: by the
    // element's src while it is on its way there.
    const cwGet = (k: string): ((this: unknown) => unknown) | undefined =>
        nO.getOwnPropertyDescriptor((targetWindow as unknown as Record<string, { prototype: object } | undefined>)[k]?.prototype ?? {}, "contentWindow")?.get;
    const cw = [cwGet("HTMLIFrameElement"), cwGet("HTMLFrameElement")];
    const qsa = nO.getOwnPropertyDescriptor((targetWindow as unknown as { Document: { prototype: object } }).Document.prototype, "querySelectorAll")?.value as ((this: unknown, s: string) => ArrayLike<Element>) | undefined;
    const elementOf = (v: unknown): unknown => {
        let all: ArrayLike<Element> = [];
        try { all = qsa ? ncall(qsa, targetWindow.document, "iframe,frame") : []; } catch { return null; }
        for (let i = 0; i < all.length; i++) {
            const e = all[i]!;
            for (const g of cw) { try { if (g && ncall(g, e) === v) return e; } catch { /* not this kind */ } }
        }
        return null;
    };
    const shown = (v: unknown): unknown => {
        if (typeof v !== "object" || v === null) return v;
        const el = elementOf(v);
        return crossOriginView(v, el ? pendingOrigin(el) : null, targetWindow);
    };
    const define = (n: string): void => {
        if (mine.has(n) || nO.getOwnPropertyDescriptor(proto, n)) return;
        mine.set(n, true);
        const d = nO.getOwnPropertyDescriptor({
            get [n]() { return shown(nR.get(named, n, this)); },
            set [n](v: unknown) { nO.defineProperty(this as object, n, { value: v, writable: true, enumerable: true, configurable: true }); },
        }, n)!;
        nO.defineProperty(proto, n, { get: d.get!, set: d.set!, enumerable: false, configurable: true });
        hideOwn(proto, n);
    };
    const drop = (n: string): void => {
        mine.delete(n);
        try { delete (proto as Record<string, unknown>)[n]; } catch { /* stays */ }
        showOwn(proto, n);
    };
    const sync = (): void => {
        const now = new SafeMap<string, true>();
        let len = 0;
        try { len = targetWindow.length; } catch { return; }
        for (let i = 0; i < len; i++) {
            let n = "";
            try { n = (targetWindow as unknown as Window[])[i]!.name; } catch { continue; } // the browser's own cross-origin rules
            if (n !== "") now.set(n, true);
        }
        for (const n of [...mine.keys()]) if (!now.has(n)) drop(n);
        for (const n of now.keys()) define(n);
    };
    sync();
    onInserted(targetWindow, sync);
    try {
        targetWindow.document.addEventListener("load", sync, true); // a frame's document loaded (its name may be its own)
        targetWindow.document.addEventListener("DOMContentLoaded", sync);
        targetWindow.document.addEventListener("readystatechange", sync);
    } catch { /* no document */ }
    const fr = (targetWindow as unknown as { HTMLIFrameElement?: { prototype: object } }).HTMLIFrameElement;
    if (fr) wrapAccessor<string>(fr.prototype, "name", { set: (nativeSet, self, v) => { ncall(nativeSet, self, v); sync(); } });
    const el = (targetWindow as unknown as { Element?: { prototype: object } }).Element;
    if (el) {
        wrapMethod<(...a: unknown[]) => unknown>(el.prototype, "setAttribute", (native, self, args) => {
            const r = nR.apply(native, self, args);
            if (typeof args[0] === "string" && args[0].toLowerCase() === "name") sync();
            return r;
        });
    }
}
