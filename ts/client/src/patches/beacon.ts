// navigator.sendBeacon(url, data), as page code sees it natively: the
// method on Navigator.prototype, only the URL proxified.

import { wrapMethod } from "../native/surface";

export function patchSendBeacon(targetWindow: Window, rewriteOne: (url: string) => string): void {
    const nav = targetWindow.navigator;
    if (!nav) return;
    // Wrapped where it lives (Navigator.prototype in a browser).
    wrapMethod<(...a: unknown[]) => boolean>(nav, "sendBeacon", (native, self, args) => {
        if (!args.length) return Reflect.apply(native, self, args) as boolean;
        return Reflect.apply(native, self, [rewriteOne(String(args[0])), ...args.slice(1)]) as boolean;
    });
}
