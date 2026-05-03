// Block service worker registration for the proxy origin.
//
// Service workers run in their own global context where $rewriter is never
// defined, so any SW script rewritten by the server will throw
// "ReferenceError: $rewriter is not defined" the moment it executes.
//
// Worse: a registered SW on localhost:9081 intercepts *all* fetches from that
// origin — including the proxy's own traffic — before they reach our patches,
// breaking URL containment entirely.
//
// Fix: stub out navigator.serviceWorker.register() so registration silently
// resolves, and unregister any SW that was installed on this origin in a
// prior session.

export function patchServiceWorker(targetWindow: Window): void {
    const sw = targetWindow.navigator?.serviceWorker;
    if (!sw) return;

    // Unregister any previously-installed service workers for this origin.
    sw.getRegistrations().then((regs) => {
        for (const reg of regs) reg.unregister();
    }).catch(() => { /* non-fatal */ });

    // Stub register() so future calls are silently swallowed.
    Object.defineProperty(sw, "register", {
        configurable: true,
        writable: true,
        value: (): Promise<ServiceWorkerRegistration> =>
            new Promise(() => { /* never resolves — caller gets a pending promise */ }),
    });
}
