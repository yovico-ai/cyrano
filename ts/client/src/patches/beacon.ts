// Patch `navigator.sendBeacon` so analytics/telemetry beacons go through
// the proxy instead of hitting their origin servers directly.
//
// sendBeacon(url, data) is used by Google Analytics (GA4), doubleclick, and
// other analytics platforms to send tracking data without blocking the page.
// Without this patch, every sendBeacon call bypasses URL containment and
// creates a direct connection to the analytics origin.
//
// The `data` argument (body) is passed through unchanged — we only rewrite
// the URL.

export function patchSendBeacon(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
): void {
    const nav = targetWindow.navigator;
    if (!nav?.sendBeacon) return;

    const origSendBeacon = nav.sendBeacon.bind(nav);

    nav.sendBeacon = function patchedSendBeacon(
        url: string | URL,
        data?: BodyInit | null,
    ): boolean {
        const raw = url instanceof URL ? url.href : String(url);
        return origSendBeacon(rewriteOne(raw), data);
    };
}
