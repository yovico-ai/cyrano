// postMessage's targetOrigin, as HTML defines it, for windows that all
// really live on the proxy origin: a port of spec/Messaging.agda delivery,
// which is the authority (checked against it: message-conformance; the
// spec against Chromium: post-message-vs-chromium).
//
// Natively: "*" delivers to any recipient; "/" only to one whose origin is
// the sender's; anything else is parsed as a URL (a parse failure throws a
// SyntaxError) and delivers only if its origin is the recipient's — a
// mismatch is dropped silently. Under cyrano every proxied window's real
// origin is the proxy's, so the comparison is made between the windows'
// original origins, and a delivery goes to the native with the proxy origin.

import { trusted } from "../native/trusted";
import { SafeSet, SafeWeakMap, nO, nR, napply, nqueueMicrotask } from "../native/intrinsics";
import { realWindow } from "../native/cross-origin";
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
    // An opaque origin (data:, javascript:; file: reads "null" too): the
    // native decides — it throws a SyntaxError, or drops a file: one
    // (spec/Messaging.agda). Compared as a string it was silently dropped.
    if (wanted === "null") return { kind: "native" };
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
        return n ? napply(n, recipient, args) : (recipient as { postMessage: (...a: unknown[]) => unknown }).postMessage(...args);
    } satisfies Send;
}

/** The recipient's own native postMessage. */
export function nativeOf(win: unknown): ((...a: unknown[]) => unknown) | undefined {
    return internalsOf(win)?.nativePostMessage;
}

/** Sends `args` to `recipient` as `sender` (falls back to the native from here). */
export function sendAs(sender: unknown, recipient: unknown, args: unknown[], fallback: () => unknown): unknown {
    const n = nativeOf(recipient);
    if (n) {
        const sent = callInRealmOf(sender, n, recipient, args);
        if (sent !== NOT_SENT) return sent;
    }
    const send = internalsOf(sender)?.send;
    return send ? send(recipient, args) : fallback();
}

/**
 * The browser takes a message's source and origin from the realm of the
 * calling function (the incumbent realm), not from the window the runtime
 * acts for. Under the proxy a frame's runtime may be its creator's: a blank
 * frame the creator injected and that then navigated keeps its Window
 * object (every document is same-origin to the browser), and with it the
 * creator's copy of the runtime. The native postMessage is therefore called
 * from a function compiled in the sender's own realm.
 */
const trampolines = new SafeWeakMap<object, (f: unknown, self: unknown, args: unknown[]) => unknown>();
export const NOT_SENT = Symbol("not sent");
export function callInRealmOf(sender: unknown, fn: unknown, self: unknown, args: unknown[]): unknown {
    if (typeof sender !== "object" || sender === null) return NOT_SENT;
    // A realm with a copy of the runtime of its own calls through it (its
    // realmApply): a compile there is refused under a CSP without
    // 'unsafe-eval', and the violation fires at the page (Disqus, Google
    // sign-in frames on dexterdaily.com). Looked up first: an empty frame
    // that navigates keeps its Window and gets a copy then.
    if (sender !== (globalThis as unknown)) {
        const own = internalsOf(sender)?.realmApply;
        if (own) return own(fn, self, args);
    }
    let t = trampolines.get(sender);
    if (!t) {
        try {
            const F = nativeFunctionOf(sender);
            if (!F) return NOT_SENT;
            // The saved apply is handed in: the compiled body never looks up
            // the page-writable Reflect.apply. (A built-in does not change the
            // incumbent realm: the trampoline stays the calling function.)
            // The runtime's own realm (the window its bundle was loaded
            // into) has a function of its own to call through: nothing is
            // compiled — under Trusted Types that would be a violation,
            // fired at the page (Pinterest, 2026-11-20; Chrome's Function
            // takes no TrustedScript either).
            // Otherwise only a frame that runs on its creator's copy (an
            // empty frame) is compiled into.
            if (sender === (globalThis as unknown)) {
                t = (f: unknown, s: unknown, a: unknown[]) => nR.apply(f as (...x: unknown[]) => unknown, s, a);
            } else {
                // Compiled in the sender's realm by its own eval, given a
                // TrustedScript of the runtime's policy: under Trusted Types
                // eval takes one, Chrome's Function does not. Where eval
                // hands the object back (no Trusted Types), Function does it.
                type Make = (ap: typeof nR.apply) => (f: unknown, self: unknown, args: unknown[]) => unknown;
                const body = "return function (f, t, a) { return ap(f, t, a); }";
                const ev = (sender as { eval?: (x: unknown) => unknown }).eval;
                const code = `(function (ap) { ${body} })`;
                // The sender realm's own policy, else the runtime's (a frame
                // that has none of its own: same-origin, it takes ours).
                let script = trusted(sender, "Script", code);
                if (typeof script === "string") script = trusted(globalThis, "Script", code);
                let make = typeof ev === "function" ? nR.apply(ev, sender, [script]) : undefined;
                if (typeof make !== "function") make = nR.construct(F, ["ap", body]);
                t = (make as Make)(nR.apply);
            }
            trampolines.set(sender, t);
        } catch {
            // Really cross-origin, or a realm that refuses to compile: asked
            // once (each refusal is a violation the page sees).
            try { trampolines.set(sender, () => NOT_SENT); } catch { /* not a key */ }
            return NOT_SENT;
        }
    }
    return t(fn, self, args);
}

/** A window's native Function constructor (the runtime's stand-in compiles through it too). */
function nativeFunctionOf(win: object): FunctionConstructor | undefined {
    try {
        const fp = nO.getPrototypeOf((win as { Object: { prototype: object } }).Object.prototype.constructor) as { constructor?: FunctionConstructor } | null;
        const F = fp?.constructor;
        return typeof F === "function" ? F : (win as { Function?: FunctionConstructor }).Function;
    } catch {
        return undefined;
    }
}

// ── The sender, told by the calling window's own runtime ────────────────

/**
 * Rewritten page code reads `x.postMessage` through its own window's
 * runtime ($rewriter.wrap_postMessage / wrap_member_expression): that
 * runtime's window is the sender of the call that follows. It is noted on
 * the recipient, for the recipient's postMessage wrapper. The stack-based
 * guess (callingWindow) cannot tell two windows apart that run the same
 * script URL (PayPal's SDK runs in the page and in its button frame).
 */
export function markSender(recipient: unknown, sender: Window): void {
    let i: Internals | undefined;
    try { i = internalsOf(realWindow(recipient)); } catch { i = undefined; }
    if (!i) return;
    i.pendingSender = sender;
    const mark = i;
    try { nqueueMicrotask(() => { if (mark.pendingSender === sender) mark.pendingSender = undefined; }); } catch { /* cleared on use */ }
}

/** The sender noted for this window's next postMessage, once. */
export function takeSender(internals: Internals): Window | undefined {
    const s = internals.pendingSender;
    internals.pendingSender = undefined;
    return s;
}

// ── Finding the calling window ─────────────────────────────────────────

/** The script URLs on the current call stack, innermost first (native/error-stack.ts). */
export const callerUrls = rawStackUrls;

/** Every same-origin window reachable from `from`: the frame tree, openers, and every registered window. */
export function reachableWindows(from: Window): Window[] {
    const seen = new SafeSet<Window>();
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
