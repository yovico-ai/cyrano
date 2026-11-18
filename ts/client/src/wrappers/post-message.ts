
// Wrapper for `*.postMessage` calls.
//
// The server's WRAP_POST_MESSAGE rule fires on ANY `obj.postMessage` member-
// access — Window, MessagePort, BroadcastChannel, ServiceWorker, Worker, etc.
// We can't assume the obj is a Window. The transform is just:
//   obj.postMessage(...args)  →  $rewriter.wrap_postMessage({obj: obj}).postMessage(...args)
//
// targetOrigin translation: this wrapper handles rewritten scripts that call
// postMessage on ANY target window — including ad iframe windows that may not
// have the Window.prototype.postMessage prototype patch installed. The prototype
// patch (patches/post-message.ts) covers non-rewritten scripts calling postMessage
// on the CURRENT window. These two mechanisms cover different scenarios and are
// not redundant.
//
// The translation gate: if the target's .location is readable (same-origin =
// proxied window), translate the upstream targetOrigin to the proxy origin.
// If .location throws SecurityError, it's a genuinely cross-origin window —
// leave the targetOrigin unchanged.
//
// TODO: rewrite proxy-origin URLs in message payloads before they cross frame
// boundaries (so the receiver sees the original upstream URL, not the proxy
// URL, in event.data fields that carry URLs).

export interface PostMessageWrapper {
    postMessage: (...args: unknown[]) => unknown;
}

/**
 * `obj.postMessage(...)` from rewritten code: the call goes to the
 * recipient's postMessage — the native-surface wrapper
 * (patches/post-message.ts), which finds this code's window on the call
 * stack and sends as it. Anything that is not a window (MessagePort,
 * Worker, BroadcastChannel, …) is called as written.
 */
export function wrapPostMessage(
    arg: { obj: unknown },
    _proxyOrigin: string,
    _senderOrigin: () => string | null,
    _unwrap: (href: string) => string,
): PostMessageWrapper {
    const target = arg.obj as { postMessage?: (...a: unknown[]) => unknown } | null;
    return {
        postMessage: (...args: unknown[]): unknown =>
            (target?.postMessage as (...a: unknown[]) => unknown).apply(target, args),
    };
}
