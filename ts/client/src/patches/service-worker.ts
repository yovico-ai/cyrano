// navigator.serviceWorker: cyrano does not let a page install a service
// worker (it would serve responses cyrano never rewrites), and removes any
// left over. register() keeps the native's surface (ServiceWorkerContainer
// .prototype.register) and returns a promise that never settles.
//
// getRegistration(clientURL) is judged against the page's own origin, as
// the native judges it against the document's (staples.com, 2026-11-22: its
// own absolute URL was refused with a SecurityError naming the proxy's
// origin): one that does not parse is the native's to refuse; another
// origin is refused with the native's SecurityError, naming the page's;
// otherwise there is no registration (none can be made).

import { stacked } from "../native/stacked";
import { nR } from "../native/intrinsics";
import { wrapMethod } from "../native/surface";

export function patchServiceWorker(targetWindow: Window, getBase: () => URL = () => new URL(targetWindow.location.href)): void {
    let sw: ServiceWorkerContainer | undefined;
    try {
        sw = targetWindow.navigator?.serviceWorker;
    } catch {
        return; // a sandboxed frame: the getter throws, and so it does for the page
    }
    if (!sw) return;
    sw.getRegistrations().then((regs) => {
        for (const reg of regs) void reg.unregister();
    }).catch(() => { /* non-fatal */ });
    const C = (targetWindow as unknown as { ServiceWorkerContainer?: { prototype: object } }).ServiceWorkerContainer;
    if (!C?.prototype) return;
    wrapMethod(C.prototype, "register", () => new Promise<ServiceWorkerRegistration>(() => { /* never settles */ }));
    const g = targetWindow as unknown as { Promise: PromiseConstructor; DOMException: typeof DOMException };
    wrapMethod<(...a: unknown[]) => Promise<ServiceWorkerRegistration | undefined>>(C.prototype, "getRegistration", (native, self, args) => {
        let base: URL;
        let u: URL;
        try {
            base = getBase();
            u = new URL(args.length && args[0] !== undefined ? String(args[0]) : "", base);
        } catch {
            return nR.apply(native, self, args) as Promise<ServiceWorkerRegistration | undefined>; // the native refuses it
        }
        if (u.origin !== base.origin) {
            return g.Promise.reject(stacked(new g.DOMException(
                `Failed to get a ServiceWorkerRegistration: The origin of the provided documentURL ('${u.origin}') does not match the current origin ('${base.origin}').`,
                "SecurityError")));
        }
        return g.Promise.resolve(undefined);
    });
}
