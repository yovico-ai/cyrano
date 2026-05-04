// Prototype-level patch for Window.prototype.postMessage.
//
// The AST rewriter wraps every `obj.postMessage(…)` call site with
// $rewriter.wrap_postMessage({obj}).postMessage(…), which translates the
// targetOrigin argument for rewritten scripts. But scripts that are NOT
// rewritten (ad SDKs loaded from third-party CDNs, inline scripts generated
// by document.write, etc.) bypass the AST wrapper and call the native method
// directly — so the targetOrigin is never translated and the browser throws a
// SecurityError because the target window's REAL origin is the proxy origin
// (e.g. 'http://localhost:9081'), not the upstream origin that the script
// expects (e.g. 'https://www.zerohedge.com').
//
// This patch closes that gap by wrapping Window.prototype.postMessage itself,
// so EVERY postMessage call on any window in this realm goes through the
// translation, regardless of whether the caller was AST-rewritten.
//
// Cross-origin guard: the browser throws a SecurityError when code reads any
// property of a cross-origin window's location. We try to read the recipient's
// location inside a try/catch; if that succeeds the window is same-origin
// (= proxied) and we translate; if it throws we leave the targetOrigin
// unchanged so postMessage to truly external windows is unaffected.

type WindowGlobals = Record<string, { prototype: Record<string, unknown> } | undefined>;

export function patchPostMessage(targetWindow: Window, proxyOrigin: string): void {
    const globals = targetWindow as unknown as WindowGlobals;
    const TargetWindow = globals["Window"];
    if (!TargetWindow?.prototype) return;

    const proto = TargetWindow.prototype;
    const orig = proto["postMessage"];
    if (typeof orig !== "function") return;

    proto["postMessage"] = function patchedPostMessage(
        this: Window,
        ...args: unknown[]
    ): void {
        (orig as (...a: unknown[]) => void).apply(this, translateOrigin(this, args, proxyOrigin));
    };
}

function translateOrigin(recipient: unknown, args: unknown[], proxyOrigin: string): unknown[] {
    if (args.length < 2) return args;
    const targetOrigin = args[1];
    if (typeof targetOrigin !== "string" || targetOrigin === "*" || targetOrigin === "/" || targetOrigin === proxyOrigin) return args;

    try {
        // Reading .location throws SecurityError for cross-origin windows.
        // If it succeeds, the recipient is same-origin = a proxied window.
        const win = recipient as { location?: unknown };
        const loc = win.location;
        if (loc != null) {
            const fixed = args.slice();
            fixed[1] = proxyOrigin;
            return fixed;
        }
    } catch {
        // Cross-origin recipient — leave targetOrigin unchanged.
    }
    return args;
}
