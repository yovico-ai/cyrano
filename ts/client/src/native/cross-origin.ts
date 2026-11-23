// The same-origin policy between windows, re-created.
//
// Every proxied window really lives on the proxy's origin, so the browser
// lets any of them reach into any other: a frame from another site can read
// `parent.document`, and the page can read its `contentDocument`. Directly,
// both throw a SecurityError — and a script may rely on that, or test for it
// (a challenge frame checks that it really is cross-origin to its embedder).
//
// So wherever page code obtains another window — parent, top, opener, an
// iframe's contentWindow, a message's source, window.open's result — it is
// given, when that window's original origin differs from its own, a view
// that behaves as a cross-origin WindowProxy does (HTML, "CrossOriginGet"):
// postMessage, close, focus, blur, closed, length, frames, self, window,
// parent, top, opener, indexed frames, and a location that can be set or
// replaced but not read. Anything else throws SecurityError.
//
// One view per window (per viewing realm), so identity holds:
// `event.source === iframe.contentWindow`.
//
// The runtime's own code works with the real windows (`realWindow`).
//
// Known gaps: `window[0]` / `frames[0]` give the real child window;
// document.domain relaxation is not modelled.

import { SafeWeakMap, SafeWeakSet, nO, ncall, aIncludes } from "./intrinsics";
import { internalsOf } from "./internals";
import { heldAttr } from "./originals";
import { frameDest, type Dest } from "../url/containment";

type Navigate = ((url: string) => string) & { withMark?: (url: string, policy: string | null, dest: Dest | null) => string };

// Per viewing window: the runtime is one module shared by a page and the
// empty frames it initializes, so nothing here may be module-wide.
interface Viewer {
    win: Window;
    origin: () => string;
    navigate: Navigate;
    /** Really cross-origin windows' location views (one per window). */
    locations: WeakMap<object, object>;
    opener: ((this: Window) => unknown) | undefined;
    views: WeakMap<object, object>;
    /** Windows page code of this realm already holds as themselves. */
    handedOut: WeakSet<object>;
    /** A proxified URL's original (unchanged when it is not one). */
    unwrap: (url: string) => string;
}
const viewers = new SafeWeakMap<object, Viewer>();
let nativeContentWindow: ((this: unknown) => Window | null) | undefined;

const reals = new SafeWeakMap<object, Window>();

/** Sets up `win`'s views: its original origin, and how it proxifies a URL it navigates to. */
export function initCrossOrigin(win: Window, origin: () => string, rewriteOne: Navigate, unwrapOne: (url: string) => string = (u) => u): void {
    viewers.set(win, {
        win, origin, navigate: rewriteOne, unwrap: unwrapOne, views: new SafeWeakMap(), locations: new SafeWeakMap(), handedOut: new SafeWeakSet(),
        opener: nO.getOwnPropertyDescriptor(win, "opener")?.get as Viewer["opener"],
    });
    if (!nativeContentWindow) {
        const F = (win as unknown as { HTMLIFrameElement?: { prototype: object } }).HTMLIFrameElement?.prototype;
        nativeContentWindow = F ? (nO.getOwnPropertyDescriptor(F, "contentWindow")?.get as typeof nativeContentWindow) : undefined;
    }
}

/** An iframe's real window, whatever page code is shown. */
export function contentWindowOf(frame: unknown): Window | null {
    try {
        return nativeContentWindow ? ncall(nativeContentWindow, frame) : ((frame as HTMLIFrameElement).contentWindow as Window | null);
    } catch {
        return null;
    }
}

/** The real window behind a view (or the value itself). */
export function realWindow<T>(x: T): T | Window {
    return (typeof x === "object" && x !== null && reals.get(x)) || x;
}

export function isView(x: unknown): boolean {
    return typeof x === "object" && x !== null && reals.has(x);
}

/**
 * The original origin of a window: its runtime's, or — a proxied document
 * that got no runtime (no script of its own can run there: spec/Csp.agda
 * noScriptsRun) — its proxified URL's. Null when neither tells.
 */
function originalOriginOf(w: unknown, unwrap: (url: string) => string): string | null {
    try {
        const base = internalsOf(w)?.api.get_base_url();
        if (base) return base.origin;
        const href = (w as Window).location.href;
        const orig = unwrap(href);
        return orig !== href ? new URL(orig).origin : null;
    } catch {
        return null;
    }
}

/**
 * What page code of this realm gets when it obtains `target`: the window
 * itself when it is same-origin (or not a proxied window at all), a
 * cross-origin view otherwise. `pendingOrigin`: the origin the window is
 * navigating to, when known (an iframe's src).
 */
export function crossOriginView<T>(target: T, pendingOrigin: string | null = null, from?: object): T {
    const v = from ? viewers.get(from) : undefined;
    if (!v || typeof target !== "object" || target === null || (target as unknown) === v.win) return target;
    if (reals.has(target)) return target;
    let isWindow = false;
    try {
        isWindow = (target as unknown as Window).window === (target as unknown);
    } catch {
        return target; // really cross-origin: the browser's own rules apply
    }
    if (!isWindow) return target;
    // A frame that is on its way to another origin (its element's src says
    // so) is that origin's already: page code that takes its contentWindow
    // before the navigation commits must hold the same object it will later
    // see as a message's source — a browser has one WindowProxy throughout.
    const mine = v.origin();
    const theirs = originalOriginOf(target, v.unwrap);
    // The pending origin stands while the frame is still on its initial
    // about:blank; once a document has committed, it is that document's
    // origin — a frame sent elsewhere may be redirected back (Q4's sign-in
    // frame on ir.netflix.net came back to the page's own origin, and the
    // page read its location: proxied it threw).
    let committed = false;
    try { committed = (target as unknown as Window).location.href !== "about:blank"; } catch { committed = false; }
    const cross = pendingOrigin !== null && !(committed && theirs !== null)
        ? pendingOrigin !== mine
        : theirs !== null && theirs !== mine;
    // A browser has one WindowProxy for a frame through all its
    // navigations: page code that took it while the frame was still its own
    // origin's (a blank frame a script writes into, then navigates) keeps
    // getting that object, however the frame's origin changes — PayPal
    // stores callbacks keyed by it and looks them up by a message's source.
    // (Its cross-origin restrictions are then not enforced for that page.)
    if (!cross) { v.handedOut.add(target as unknown as object); return target; }
    if (v.handedOut.has(target as unknown as object)) return target;
    let view = v.views.get(target);
    if (!view) {
        view = makeView(target as unknown as Window, v);
        v.views.set(target, view);
        reals.set(view, target as unknown as Window);
    }
    return view as T;
}

function securityError(v: Viewer): Error {
    const DE = (v.win as unknown as { DOMException: typeof DOMException }).DOMException;
    return new DE(`Blocked a frame with origin "${v.origin()}" from accessing a cross-origin frame.`, "SecurityError");
}

const WINDOW_KEYS = ["window", "self", "location", "close", "closed", "focus", "blur", "frames", "length", "top", "opener", "parent", "postMessage"];
const isIndex = (p: string): boolean => /^(0|[1-9]\d*)$/.test(p);
/** Symbols a cross-origin object answers `undefined` to instead of throwing. */
const quietSymbol = (p: symbol): boolean => p === Symbol.toStringTag || p === Symbol.hasInstance || p === Symbol.isConcatSpreadable;

/** The child frame of t whose name is `name`, if any (the first, in order). */
function childNamed(t: Window, name: string): Window | undefined {
    if (name === "") return undefined;
    try {
        const n = t.length;
        for (let k = 0; k < n; k++) {
            const c = (t as unknown as Record<number, Window>)[k];
            let cn: string;
            try { cn = c!.name; } catch { continue; }
            if (cn === name) return c;
        }
    } catch { /* none */ }
    return undefined;
}

function makeView(t: Window, v: Viewer): object {
    const location = makeLocationView(t, v);
    const fns: Record<string, (...a: unknown[]) => unknown> = {
        postMessage: (...a) => (t.postMessage as (...x: unknown[]) => unknown)(...a),
        close: () => t.close(),
        focus: () => t.focus(),
        blur: () => t.blur(),
    };
    const get = (p: string | symbol): unknown => {
        if (typeof p === "symbol") {
            if (quietSymbol(p)) return undefined;
            throw securityError(v);
        }
        switch (p) {
            case "window": case "self": case "frames": return view;
            case "parent": return crossOriginView(t.parent, null, v.win);
            case "top": return crossOriginView(t.top, null, v.win);
            case "opener": return crossOriginView(v.opener ? ncall(v.opener, t) : t.opener, null, v.win);
            case "length": return t.length;
            case "closed": return t.closed;
            case "location": return location;
            case "postMessage": case "close": case "focus": case "blur": return fns[p];
            case "then": return undefined;
        }
        if (isIndex(p)) {
            const child = (t as unknown as Record<string, unknown>)[p];
            return child === undefined ? undefined : crossOriginView(child, null, v.win);
        }
        // A child frame by its name (HTML "document-tree child navigable
        // target name property set"): reCAPTCHA's challenge frame finds its
        // anchor frame as parent.frames["a-…"].
        const named = childNamed(t, p);
        if (named !== undefined) return crossOriginView(named, null, v.win);
        throw securityError(v);
    };
    const known = (p: string | symbol): boolean =>
        typeof p === "string"
            ? aIncludes(WINDOW_KEYS, p) || p === "then" || (isIndex(p) && Number(p) < t.length) || childNamed(t, p) !== undefined
            : quietSymbol(p);
    const view: object = new Proxy({}, {
        get: (_o, p) => get(p),
        set: (_o, p, value) => {
            if (p !== "location") throw securityError(v);
            (location as { href: unknown }).href = value;
            return true;
        },
        has: (_o, p) => {
            if (known(p)) return true;
            throw securityError(v);
        },
        getOwnPropertyDescriptor: (_o, p) => {
            if (!known(p)) throw securityError(v);
            return { value: get(p), writable: false, enumerable: false, configurable: true };
        },
        ownKeys: () => [...WINDOW_KEYS, "then", Symbol.toStringTag, Symbol.hasInstance, Symbol.isConcatSpreadable],
        defineProperty: () => { throw securityError(v); },
        deleteProperty: () => { throw securityError(v); },
        getPrototypeOf: () => null,
        setPrototypeOf: (_o, proto) => proto === null,
    });
    return view;
}

/**
 * The mark of a URL `viewer` sends `win` to, when `win` is a child frame
 * of it: the parent gives the frame its URL, as by its src (spec Frames
 * embedderOf), and the frame's sandbox stays with it (frameDest). The
 * frame's element is looked for in the viewer's document; one in a shadow
 * tree is not found, and counts as unsandboxed.
 */
export function childFrameDest(win: unknown, viewer: Window | undefined): Dest | undefined {
    try {
        if (viewer === undefined || win === viewer || (win as Window).parent !== viewer) return undefined;
        const frames = viewer.document.getElementsByTagName("iframe");
        for (let i = 0; i < frames.length; i++) {
            if (contentWindowOf(frames[i]) === win) return frameDest(heldAttr(frames[i]!, "sandbox"));
        }
        return "frame";
    } catch {
        return undefined;
    }
}

/**
 * The location of a window the browser itself holds cross-origin to
 * `from` (a sandboxed frame's opaque origin): natively it can be navigated
 * and not read, and the URL is resolved against the navigating document's
 * base — the page's original one, here. Undefined when `from` has no views.
 */
export function opaqueLocationView(target: object, from: object | undefined): object | undefined {
    const v = from ? viewers.get(from) : undefined;
    if (!v) return undefined;
    let view = v.locations.get(target);
    if (!view) {
        view = makeLocationView(target as Window, v);
        v.locations.set(target, view);
    }
    return view;
}

/** A cross-origin Location: it can be navigated, not read. */
function makeLocationView(t: Window, v: Viewer): object {
    const to = (url: string): string => {
        const dest = childFrameDest(t, v.win);
        return dest && v.navigate.withMark ? v.navigate.withMark(url, null, dest) : v.navigate(url);
    };
    const replace = (url: unknown): void => t.location.replace(to(String(url)));
    return new Proxy({}, {
        get: (_o, p) => {
            if (p === "replace") return replace;
            if (p === "then" || (typeof p === "symbol" && quietSymbol(p))) return undefined;
            throw securityError(v);
        },
        set: (_o, p, value) => {
            if (p !== "href") throw securityError(v);
            t.location.href = to(String(value));
            return true;
        },
        has: (_o, p) => {
            if (p === "href" || p === "replace" || p === "then" || (typeof p === "symbol" && quietSymbol(p))) return true;
            throw securityError(v);
        },
        getOwnPropertyDescriptor: (_o, p) => {
            if (p === "replace") return { value: replace, writable: false, enumerable: false, configurable: true };
            if (p === "then" || (typeof p === "symbol" && quietSymbol(p))) return { value: undefined, writable: false, enumerable: false, configurable: true };
            throw securityError(v);
        },
        ownKeys: () => ["href", "replace", "then", Symbol.toStringTag, Symbol.hasInstance, Symbol.isConcatSpreadable],
        defineProperty: () => { throw securityError(v); },
        deleteProperty: () => { throw securityError(v); },
        getPrototypeOf: () => null,
        setPrototypeOf: (_o, proto) => proto === null,
    });
}
