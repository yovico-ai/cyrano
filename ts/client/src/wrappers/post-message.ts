// Wrapper for `*.postMessage` calls.
//
// The server's WRAP_POST_MESSAGE rule fires on ANY `obj.postMessage` member-
// access — Window, MessagePort, BroadcastChannel, ServiceWorker, Worker, etc.
// We can't assume the obj is a Window. The transform is just:
//   obj.postMessage(...args)  →  $rewriter.wrap_postMessage({obj: obj}).postMessage(...args)
//
// targetOrigin translation is handled at the prototype level by patchPostMessage
// in patches/post-message.ts, which patches Window.prototype.postMessage so
// that every call in the realm — from rewritten AND non-rewritten scripts —
// goes through the translation. No need to duplicate it here.
//
// TODO: rewrite proxy-origin URLs in message payloads before they cross frame
// boundaries (so the receiver sees the original upstream URL, not the proxy
// URL, in event.data fields that carry URLs).

export interface PostMessageWrapper {
    postMessage: (...args: unknown[]) => unknown;
}

interface PostMessageCapable {
    postMessage?: (...args: unknown[]) => unknown;
}

export function wrapPostMessage(
    arg: { obj: unknown },
    _proxyOrigin: string,
): PostMessageWrapper {
    const target = arg.obj as PostMessageCapable | null;
    return {
        postMessage: (...args: unknown[]): unknown => {
            if (!target || typeof target.postMessage !== "function") return undefined;
            return target.postMessage.apply(target, args as Parameters<typeof target.postMessage>);
        },
    };
}
