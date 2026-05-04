// Wrapper for `*.postMessage` calls.
//
// The server's WRAP_POST_MESSAGE rule fires on ANY `obj.postMessage` member-
// access — Window, MessagePort, BroadcastChannel, ServiceWorker, Worker, etc.
// We can't assume the obj is a Window. The transform is just:
//   obj.postMessage(...args)  →  $rewriter.wrap_postMessage({obj: obj}).postMessage(...args)
//
// targetOrigin translation: widgets like Cloudflare Turnstile create iframes
// and then call iframeWindow.postMessage(data, 'https://upstream.com').
// Through the proxy, the iframe's real origin is the proxy origin
// (e.g. 'http://localhost:9081'), not 'https://upstream.com', so Chrome
// throws a SecurityError. We detect this by checking whether the target
// window's location is readable (= same-origin = proxied), and if so
// substitute the proxy origin for the caller's upstream targetOrigin.
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
    proxyOrigin: string,
): PostMessageWrapper {
    const target = arg.obj as PostMessageCapable | null;
    return {
        postMessage: (...args: unknown[]): unknown => {
            if (!target || typeof target.postMessage !== "function") return undefined;
            return target.postMessage.apply(target, translateTargetOrigin(target, args, proxyOrigin));
        },
    };
}

// translateTargetOrigin replaces the targetOrigin argument (args[1]) with the
// proxy origin when the target window is a proxied frame. A proxied frame is
// same-origin with us, so its location.origin is readable and equals proxyOrigin.
function translateTargetOrigin(target: PostMessageCapable, args: unknown[], proxyOrigin: string): unknown[] {
    if (args.length < 2) return args;
    const targetOrigin = args[1];
    if (typeof targetOrigin !== "string" || targetOrigin === "*" || targetOrigin === "/") return args;

    try {
        const win = target as unknown as { location?: { origin?: string } };
        if (win.location?.origin === proxyOrigin) {
            // Target is a proxied frame: translate upstream origin → proxy origin.
            const fixed = args.slice();
            fixed[1] = proxyOrigin;
            return fixed;
        }
    } catch {
        // target.location threw (cross-origin, not a proxied frame) — leave args unchanged.
    }
    return args;
}
