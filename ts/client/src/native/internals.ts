// The runtime's per-window state that other windows' runtimes must reach
// (the postMessage helpers) or that marks a window as already patched.
//
// It lives inside the window's `$rewriter` object — the one global the
// runtime needs anyway, since rewritten code calls it — as a non-enumerable
// member. Nothing is put on `window` itself: no symbol-keyed properties
// (which Object.getOwnPropertySymbols lists) and no Symbol.for registry
// keys a script could ask for by name.

import { SafeSet, nO } from "./intrinsics";
import { isWindowObject } from "./brand";
import { defineHidden } from "./hidden-globals";
import type { RewriterApi } from "../runtime/api-types";

// WeakRef, for a `lib` target that predates it.
interface Ref<T> { deref(): T | undefined }
declare const WeakRef: (new <T extends object>(target: T) => Ref<T>) | undefined;

export interface Internals {
    /** The window's runtime API: one per window, whoever initialized it. */
    api: RewriterApi;
    /** The window's own native postMessage. */
    nativePostMessage?: (...a: unknown[]) => unknown;
    /** Sends a message to `recipient` from this window's realm. */
    send?: (recipient: unknown, args: unknown[]) => unknown;
    /**
     * Every window of this browsing-context group that has a runtime: one
     * set, shared by all of them. `window.frames` does not list a frame
     * whose iframe is inside a shadow tree (Turnstile's is, in a closed
     * one), so the frame tree alone does not reach every window.
     */
    windows?: Set<Ref<Window>>;
    /**
     * The window whose rewritten code just read this window's `postMessage`
     * (messaging/target-origin.ts markSender): the sender of the call that
     * follows. Cleared once used, and at the end of the turn.
     */
    pendingSender?: Window | undefined;
    /** The runtime bootstrap as HTML, for documents this window creates from markup. */
    bootstrapHtml?: () => string;
}

const KEY = "_";

/** The runtime state of `win`, or undefined when it has none (or is cross-origin). */
export function internalsOf(win: unknown): Internals | undefined {
    if (!isWindowObject(win)) return undefined;
    try {
        const r = (win as { $rewriter?: Record<string, unknown> } | null)?.$rewriter;
        const i = r ? (r[KEY] as Internals | undefined) : undefined;
        return i && typeof i === "object" ? i : undefined;
    } catch {
        return undefined;
    }
}

/** Attaches `internals` to `api` and publishes `api` as the window's `$rewriter`. */
export function publish(win: Window, api: RewriterApi, internals: Internals): void {
    nO.defineProperty(api, KEY, { value: internals, enumerable: false, configurable: true, writable: false });
    defineHidden(win, "$rewriter", api); // not enumerable: native/hidden-globals.ts
    register(win, internals);
}

/** Joins `win` to the window set of its top, parent or opener (or starts one). */
function register(win: Window, internals: Internals): void {
    if (typeof WeakRef !== "function") return;
    const relatives: Array<() => unknown> = [
        () => win.top, () => win.parent, () => win.opener as unknown,
        () => (win.opener as Window | null)?.top,
    ];
    let shared: Set<Ref<Window>> | undefined;
    for (const get of relatives) {
        try {
            const other = get();
            if (other && other !== win) shared = internalsOf(other)?.windows;
        } catch { /* a really cross-origin relative */ }
        if (shared) break;
    }
    internals.windows = shared ?? new SafeSet();
    internals.windows.add(new WeakRef(win));
}

/** The live windows registered alongside `win` (itself included). */
export function registeredWindows(win: unknown): Window[] {
    const set = internalsOf(win)?.windows;
    if (!set) return [];
    const out: Window[] = [];
    for (const ref of set) {
        const w = ref.deref();
        let gone = !w;
        try { gone = gone || w!.closed; } catch { gone = true; }
        if (gone) set.delete(ref);
        else out.push(w!);
    }
    return out;
}
