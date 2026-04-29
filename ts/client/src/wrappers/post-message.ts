// Wrapper for `*.postMessage` calls.
//
// The server's WRAP_POST_MESSAGE rule fires on ANY `obj.postMessage` member-
// access — Window, MessagePort, BroadcastChannel, ServiceWorker, Worker, etc.
// We can't assume the obj is a Window. The transform is just:
//   obj.postMessage(...args)  →  $rewriter.wrap_postMessage({obj: obj}).postMessage(...args)
//
// Long-term goal: when the receiver is a cross-realm Window, translate the
// targetOrigin from the original origin (the page thinks it's on) to the
// proxy origin (where the receiver actually checks `event.origin`). That
// translation isn't wired yet — for now this is a faithful passthrough.
// Strict-origin postMessage to cross-origin windows is a leak surface
// tracked under the same TODO as eval-source rewriting.

export interface PostMessageWrapper {
    postMessage: (...args: unknown[]) => unknown;
}

interface PostMessageCapable {
    postMessage?: (...args: unknown[]) => unknown;
}

export function wrapPostMessage(arg: { obj: unknown }): PostMessageWrapper {
    const target = arg.obj as PostMessageCapable | null;
    return {
        postMessage: (...args: unknown[]): unknown => {
            if (!target || typeof target.postMessage !== "function") return undefined;
            return target.postMessage.apply(target, args);
        },
    };
}
