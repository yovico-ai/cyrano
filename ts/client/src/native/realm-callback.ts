// A callback the runtime hands to another window's natives, made that
// window's.
//
// Chromium keeps one JS wrapper per node and per event, made in the realm
// of the callback that first receives it: a MutationRecord's nodes, an
// event and its target. A MutationObserver callback or an event listener of
// one copy of the runtime, installed on another realm's document or window
// (an empty frame's, a frame that adopted its creator's runtime: bootstrap.ts
// adoptDocument), gave that frame's parsed nodes the creator's prototypes —
// in the frame's own scripts `el instanceof HTMLDivElement` was false
// (Instagram's embed invariant #63112 on blog.libro.fm;
// frame-realm-wrappers-vs-chromium).
//
// The callback is `fn` bound to that window's own Function.prototype.call:
// a bound function's realm is its target's (measured, Chromium), so the
// records and events it is called with are made in that window's realm;
// it calls `fn` with them, `this` undefined. No compile: a frame's CSP may
// refuse eval (internals.ts realmApply). The window's `call` is read when
// the runtime first makes a callback for it (at injection, before page
// code), and kept.

import { SafeWeakMap, nbind } from "./intrinsics";

const ownCall = Function.prototype.call;
const calls = new SafeWeakMap<object, unknown>();

/** `fn` as a callback of `win`'s realm (itself where that is the runtime's own). */
export function realmCallback<F extends (...a: never[]) => unknown>(win: unknown, fn: F): F {
    if (typeof win !== "object" || win === null) return fn;
    let call = calls.get(win);
    if (call === undefined) {
        try { call = (win as { Function?: { prototype?: { call?: unknown } } }).Function?.prototype?.call ?? null; } catch { call = null; }
        calls.set(win, call);
    }
    if (typeof call !== "function" || call === ownCall) return fn;
    try { return nbind(call as F, fn, undefined) as F; } catch { return fn; }
}
