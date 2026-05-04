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

interface PostMessageCapable {
    postMessage?: (...args: unknown[]) => unknown;
    location?: unknown;
}

export function wrapPostMessage(
    arg: { obj: unknown },
    proxyOrigin: string,
): PostMessageWrapper {
    const target = arg.obj as PostMessageCapable | null;
    return {
        postMessage: (...args: unknown[]): unknown => {
            if (!target || typeof target.postMessage !== "function") return undefined;
            return target.postMessage.apply(
                target,
                translateTargetOrigin(target, args, proxyOrigin) as Parameters<typeof target.postMessage>,
            );
        },
    };
}

function translateTargetOrigin(
    target: PostMessageCapable,
    args: unknown[],
    proxyOrigin: string,
): unknown[] {
    if (args.length < 2) return args;
    const targetOrigin = args[1];
    if (
        typeof targetOrigin !== "string" ||
        targetOrigin === "*" ||
        targetOrigin === "/" ||
        targetOrigin === proxyOrigin
    ) return args;

    try {
        // Reading .location throws SecurityError for cross-origin windows.
        // If it's accessible the recipient is same-origin = a proxied window.
        const loc = target.location;
        if (loc != null) {
            const fixed = args.slice();
            fixed[1] = proxyOrigin;
            return fixed;
        }
    } catch {
        // Cross-origin window or non-Window — leave targetOrigin unchanged.
    }
    return args;
}
