// window.postMessage, as page code sees it natively — for every caller,
// rewritten or not.
//
// postMessage is an own property of each window (Window is a [Global]
// interface), wrapped there. targetOrigin follows HTML against the windows'
// original origins (messaging/target-origin.ts delivery). The message is
// sent through the send helper of the window whose code is calling, found
// from the call stack, so the browser stamps that window as event.source
// (and event.origin, derived from it, is the sender's original origin): a
// window posting to itself, or a caller that cannot be told, goes to the
// native from here.

import { nO, nR, ncall } from "../native/intrinsics";
import type { ClientConfig } from "../config";
import { wrapMethod } from "../native/surface";
import type { Internals } from "../native/internals";
import { NOT_SENT, callInRealmOf, callingWindow, delivery, installSender, originalOrigin, sendAs, takeSender } from "../messaging/target-origin";

export function patchPostMessage(
    targetWindow: Window,
    config: ClientConfig,
    unwrap: (href: string) => string,
    internals: Internals,
): void {
    const proxyOrigin = new URL(config.apiBaseURL).origin;
    const runtimeUrl = config.apiBaseURL + config.source;
    const PE = (targetWindow as unknown as { PerformanceEntry?: { prototype: PerformanceEntry } }).PerformanceEntry;
    const nameGet = PE ? nO.getOwnPropertyDescriptor(PE.prototype, "name")?.get : undefined;
    const nameOf = (e: PerformanceEntry): string => (nameGet ? (ncall(nameGet, e) as string) : e.name);
    const native = wrapMethod<(...a: unknown[]) => void>(targetWindow, "postMessage", (nativeFn, receiver, args) => {
        // A bare `postMessage(...)` call has no receiver: the global object, as for any Window operation.
        const self = receiver === undefined || receiver === null ? targetWindow : receiver;
        const marked = self === targetWindow ? takeSender(internals) : undefined;
        // A bare `postMessage(…)` names the calling code's own global: this
        // window is the sender (reCAPTCHA's anchor frame runs the same
        // script URL as its page, so the stack cannot tell them apart).
        const bare = receiver === undefined || receiver === null;
        const sender = marked ?? (bare ? targetWindow : (callingWindow(targetWindow, runtimeUrl, nameOf, unwrap) ?? targetWindow));
        // postMessage(message, options): a WindowPostMessageOptions (also
        // undefined / null, as WebIDL's overload resolution takes them), its
        // targetOrigin ("/" by default) judged as the string form's — given
        // as is, the browser compared the page's origin with the proxy's and
        // dropped it (round I). Its members read once, in the native's order.
        let opts: { targetOrigin: unknown; transfer?: unknown } | null = null;
        if (args.length >= 1 && (args[1] === undefined || args[1] === null || typeof args[1] === "object" || typeof args[1] === "function")) {
            const o = args[1] as { targetOrigin?: unknown; transfer?: unknown } | null | undefined;
            const t = o == null ? undefined : o.targetOrigin;
            const tr = o == null ? undefined : o.transfer;
            opts = { targetOrigin: t === undefined ? "/" : String(t) };
            if (tr !== undefined) opts.transfer = tr;
        }
        const d = delivery(self, opts ? opts.targetOrigin : args[1], originalOrigin(sender, unwrap), proxyOrigin, unwrap);
        if (d.kind === "drop") return;
        const next = opts
            ? [args[0], d.kind === "send" ? { ...opts, targetOrigin: d.origin } : opts]
            : d.kind === "send" ? [args[0], d.origin, ...args.slice(2)] : args;
        if (sender === self || sender === targetWindow && self === targetWindow) {
            // From a function of the sender's own realm (target-origin.ts callInRealmOf).
            const sent = callInRealmOf(sender, nativeFn, self, next);
            return (sent === NOT_SENT ? nR.apply(nativeFn, self, next) : sent) as void;
        }
        return sendAs(sender, self, next, () => nR.apply(nativeFn, self, next)) as void;
    });
    if (native) installSender(internals, native);
}
