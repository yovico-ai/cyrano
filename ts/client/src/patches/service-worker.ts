// navigator.serviceWorker: cyrano does not let a page install a service
// worker (it would serve responses cyrano never rewrites), and removes any
// left over. register() keeps the native's surface (ServiceWorkerContainer
// .prototype.register) and returns a promise that never settles.

import { wrapMethod } from "../native/surface";

export function patchServiceWorker(targetWindow: Window): void {
    const sw = targetWindow.navigator?.serviceWorker;
    if (!sw) return;
    sw.getRegistrations().then((regs) => {
        for (const reg of regs) void reg.unregister();
    }).catch(() => { /* non-fatal */ });
    const C = (targetWindow as unknown as { ServiceWorkerContainer?: { prototype: object } }).ServiceWorkerContainer;
    if (!C?.prototype) return;
    wrapMethod(C.prototype, "register", () => new Promise<ServiceWorkerRegistration>(() => { /* never settles */ }));
}
