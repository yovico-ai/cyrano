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
// proxy origin when the target is a same-origin (proxied) window.
//
// The naive approach — check win.location.origin === proxyOrigin — doesn't
// work because window.location is replaced by WrappedLocation, whose .origin
// getter returns the virtual upstream origin (e.g. "https://www.zerohedge.com")
// so that page-side code sees the URL it expects. That virtual origin never
// matches proxyOrigin.
//
// The reliable cross-origin gate is the SecurityError that the browser throws
// when you READ any property of a cross-origin window's location. If we can
// read win.location without throwing, the window is same-origin with us, which
// in our proxy means it IS a proxied window whose real origin is proxyOrigin.
// Any specific targetOrigin it carries is therefore the upstream origin and
// must be replaced.
function translateTargetOrigin(target: PostMessageCapable, args: unknown[], proxyOrigin: string): unknown[] {
    if (args.length < 2) return args;
    const targetOrigin = args[1];
    if (typeof targetOrigin !== "string" || targetOrigin === "*" || targetOrigin === "/" || targetOrigin === proxyOrigin) return args;

    try {
        const win = target as unknown as { location?: unknown };
        const loc = win.location; // throws SecurityError for cross-origin windows
        if (loc != null) {
            // Same-origin window → proxied → real origin is proxyOrigin.
            const fixed = args.slice();
            fixed[1] = proxyOrigin;
            return fixed;
        }
    } catch {
        // Cross-origin window or non-Window — leave targetOrigin unchanged.
    }
    return args;
}
