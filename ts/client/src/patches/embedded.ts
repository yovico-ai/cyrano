// A document framed by another origin's page, as it is natively.
//
// Under the proxy every frame is same-origin with its top document, so the
// browser gives a third-party frame what it gives a first-party one. What
// differs natively and a script can read without asking the user:
//
//   * notifications: a cross-origin frame can never ask —
//     Notification.permission is "denied", requestPermission() resolves
//     "denied", and permissions.query({name: "notifications"}) (and
//     "push") says "denied". Cloudflare's challenge reads
//     Notification.permission off a child frame of its widget.
//
// Not here: Permissions Policy. Features whose default allowlist is
// 'self' (camera, midi, window-management, the high-entropy client
// hints …) are off in a cross-origin frame unless its `allow` attribute
// delegates them; under the proxy they stay on (document.featurePolicy,
// permissions.query, screen.isExtended show it).

import { SafeSet, SafeWeakSet, nR, ncall } from "../native/intrinsics";
import { internalsOf } from "../native/internals";
import { wrapAccessor, wrapMethod } from "../native/surface";

/** True when `win`'s top document is of another origin than `own()`. */
export function framedByAnotherOrigin(win: Window, own: () => string): boolean {
    try {
        const top = win.top;
        if (!top || top === win) return false;
        const topOrigin = internalsOf(top)?.api.get_base_url()?.origin;
        return topOrigin !== undefined && topOrigin !== own();
    } catch {
        return false; // a really cross-origin top: the browser already treats this frame as third-party
    }
}

const DENIED_NAMES = new SafeSet(["notifications", "push"]);

export function patchEmbeddedContext(targetWindow: Window, own: () => string): void {
    const g = targetWindow as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const embedded = (): boolean => framedByAnotherOrigin(targetWindow, own);

    const Notif = g["Notification"] as { requestPermission?: unknown } | undefined;
    if (Notif) {
        wrapAccessor<string>(Notif, "permission", { get: (get, self) => (embedded() ? "denied" : ncall(get, self)) });
        if (typeof Notif.requestPermission === "function") {
            wrapMethod<(...a: unknown[]) => unknown>(Notif, "requestPermission", (native, self, args) => {
                if (!embedded()) return nR.apply(native, self, args);
                const cb = args[0];
                if (typeof cb === "function") { try { (cb as (p: string) => void)("denied"); } catch { /* the page's callback */ } }
                return (g["Promise"] as PromiseConstructor).resolve("denied");
            });
        }
    }

    // permissions.query: the status object is the browser's; its state reads
    // "denied" for what a third-party frame cannot have.
    const P = g["Permissions"]?.prototype as object | undefined;
    const S = g["PermissionStatus"]?.prototype as object | undefined;
    if (P && S && "query" in P) {
        const denied = new SafeWeakSet<object>();
        const then = (g["Promise"] as PromiseConstructor).prototype.then;
        wrapMethod<(...a: unknown[]) => unknown>(P, "query", (native, self, args) => {
            const result = nR.apply(native, self, args);
            let name: unknown;
            try { name = (args[0] as { name?: unknown } | undefined)?.name; } catch { return result; }
            if (typeof name !== "string" || !DENIED_NAMES.has(name) || !embedded()) return result;
            return nR.apply(then, result, [(status: unknown) => {
                if (typeof status === "object" && status !== null) denied.add(status);
                return status;
            }]);
        });
        wrapAccessor<string>(S, "state", {
            get: (get, self) => (typeof self === "object" && self !== null && denied.has(self) ? "denied" : ncall(get, self)),
        });
    }
}
