// postMessage between origins' hosts (host mode: config.sites;
// spec/SiteContainment.agda, OriginLabel.agda). PROTOTYPE — spec to
// follow (Messaging.agda).
//
// In host mode a frame of another origin is really cross-origin to the
// browser: page code calling `other.postMessage(data, "https://ads.example")`
// reaches the browser's own postMessage (no runtime can wrap a cross-origin
// window's method), which compares that origin with the recipient's real
// one — its origin's proxy host — and would drop the message. Rewritten
// code reaches it through $rewriter.wrap_postMessage (R3), which hands out
// this sender: the target origin is translated to the host it names (the
// browser then enforces it exactly); "*" stays, "/" is the sender's own
// host. A message's origin is read back from the host it came from
// (patches/message-event.ts: the label names the origin).
// Known gap: unrewritten code calling a cross-origin window's postMessage
// with a specific origin (not "*") is dropped.

import { nR } from "../native/intrinsics";

/** Whether page code of this window can reach into `w` (same origin to the browser). */
export function reachable(w: unknown): boolean {
    try {
        void (w as Window).document;
        return true;
    } catch {
        return false;
    }
}

/** The postMessage page code gets for a recipient it cannot reach, in host mode. */
export function crossSitePostMessage(
    recipient: Window,
    ownHostOrigin: () => string,
    hostOrigin: (origin: string) => string | null,
): (...args: unknown[]) => void {
    const translate = (t: string): string => (t === "*" ? t : t === "/" ? ownHostOrigin() : hostOrigin(t) ?? t);
    return function postMessage(this: unknown, ...args: unknown[]): void {
        const target = args[1];
        let to: unknown = target;
        if (typeof target === "string") to = translate(target);
        else if (target !== null && typeof target === "object" && !Array.isArray(target)) {
            // WindowPostMessageOptions: { targetOrigin, transfer }
            const o = target as { targetOrigin?: unknown };
            if (typeof o.targetOrigin === "string") to = { ...(o as object), targetOrigin: translate(o.targetOrigin) };
        }
        const send = (recipient as unknown as { postMessage: (...a: unknown[]) => void }).postMessage;
        nR.apply(send, recipient, [args[0], to, ...args.slice(2)]);
    };
}
