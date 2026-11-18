// postMessage's targetOrigin, as HTML defines it, for windows that all
// really live on the proxy origin.
//
// Natively: "*" delivers to any recipient; "/" only to one whose origin is
// the sender's; anything else is parsed as a URL (a parse failure throws a
// SyntaxError) and delivers only if its origin is the recipient's — a
// mismatch is dropped silently. Under cyrano every proxied window's real
// origin is the proxy's, so the comparison is made between the windows'
// original origins, and a delivery goes to the native with the proxy origin.

import { rawStackUrls } from "../native/error-stack";

import { internalsOf, registeredWindows, type Internals } from "../native/internals";

export type Delivery =
    | { kind: "native" }              // leave the call to the native as written
    | { kind: "drop" }                // natively not delivered
    | { kind: "send"; origin: string }; // deliver, with this targetOrigin

/** The original origin of a window cyrano proxies, or null. */
export function originalOrigin(win: unknown, unwrap: (href: string) => string): string | null {
    try {
        const r = (win as { $rewriter?: { get_base_url?: () => URL | null } }).$rewriter;
        const base = r?.get_base_url?.();
        if (base) return base.origin;
        const href = (win as { location?: { href?: unknown } }).location?.href;
        if (typeof href !== "string") return null;
        const original = unwrap(href);
        return original === href ? null : new URL(original).origin;
    } catch {
        return null; // a really cross-origin window
    }
}

export function delivery(
    recipient: unknown,
    targetOrigin: unknown,
    senderOrigin: string | null,
    proxyOrigin: string,
    unwrap: (href: string) => string,
): Delivery {
    if (typeof targetOrigin !== "string") return { kind: "native" };
    if (targetOrigin === "*") return { kind: "native" };
    const to = originalOrigin(recipient, unwrap);
    if (to === null) return { kind: "native" };
    if (targetOrigin === "/") return senderOrigin === to ? { kind: "send", origin: proxyOrigin } : { kind: "drop" };
    let wanted: string;
    try {
        wanted = new URL(targetOrigin).origin;
    } catch {
        return { kind: "native" }; // the native throws its own SyntaxError
    }
    return wanted === to ? { kind: "send", origin: proxyOrigin } : { kind: "drop" };
}

// ── Sending as the sender ──────────────────────────────────────────────
//
// HTML stamps event.source with the window of the *incumbent* realm: the
// realm of the most recently entered author function. A wrapper installed
// on the recipient is a function of the recipient's realm, so calling the
// native from it would make the recipient the source. Instead every window
// defines, in its own realm, a send helper; a message is sent through the
// helper of the window whose code called postMessage, so the browser itself
// stamps that window as the source — and event.origin follows from it.

type Send = (recipient: unknown, args: unknown[]) => unknown;

/**
 * Records this window's send helper and its own native postMessage in its
 * runtime state (native/internals.ts). The helper is created here, in this
 * window's realm — that is the whole point.
 */
export function installSender(internals: Internals, native: (...a: unknown[]) => unknown): void {
    internals.nativePostMessage = native;
    internals.send = function send(recipient, args) {
        const n = nativeOf(recipient);
        return n ? n.apply(recipient, args) : (recipient as { postMessage: (...a: unknown[]) => unknown }).postMessage(...args);
    } satisfies Send;
}

/** The recipient's own native postMessage. */
export function nativeOf(win: unknown): ((...a: unknown[]) => unknown) | undefined {
    return internalsOf(win)?.nativePostMessage;
}

/** Sends `args` to `recipient` as `sender` (falls back to the native from here). */
export function sendAs(sender: unknown, recipient: unknown, args: unknown[], fallback: () => unknown): unknown {
    const send = internalsOf(sender)?.send;
    return send ? send(recipient, args) : fallback();
}

// ── Finding the calling window ─────────────────────────────────────────

/** The script URLs on the current call stack, innermost first (native/error-stack.ts). */
export const callerUrls = rawStackUrls;

/** Every same-origin window reachable from `from`: the frame tree, openers, and every registered window. */
export function reachableWindows(from: Window): Window[] {
    const seen = new Set<Window>();
    const visit = (w: Window | null | undefined): void => {
        if (!w || seen.has(w)) return;
        try {
            void w.location.href; // throws for a really cross-origin window
        } catch {
            return;
        }
        seen.add(w);
        try {
            for (let i = 0; i < w.frames.length; i++) visit(w.frames[i] as Window);
        } catch { /* ignore */ }
        try { visit(w.opener as Window | null); } catch { /* ignore */ }
    };
    let top: Window = from;
    try { top = from.top ?? from; } catch { /* stay */ }
    visit(top);
    visit(from);
    // Frames in shadow trees are not in any window's `frames`.
    for (const w of registeredWindows(from)) visit(w);
    return [...seen];
}

/**
 * The window whose code is calling: the first script URL on the stack that
 * is not cyrano's own runtime, matched against each reachable window's
 * document URL (an inline script) and the scripts it loaded (resource
 * timing). Null when it cannot be told.
 */
export function callingWindow(
    from: Window,
    runtimeUrl: string,
    nameOf: (e: PerformanceEntry) => string,
    unwrap: (href: string) => string,
): Window | null {
    const urls = callerUrls((from as unknown as { Error: ErrorConstructor }).Error).filter((u) => u !== runtimeUrl);
    const raw = urls[0];
    if (!raw) return null;
    // Compared as original URLs: entry names may already read back unwrapped.
    const caller = unwrap(raw);
    const windows = reachableWindows(from);
    for (const w of windows) {
        try {
            if (unwrap(w.location.href) === caller) return w;
        } catch { /* ignore */ }
    }
    for (const w of windows) {
        try {
            if (w.performance.getEntriesByType("resource").some((e) => unwrap(nameOf(e)) === caller)) return w;
        } catch { /* ignore */ }
    }
    return null;
}
