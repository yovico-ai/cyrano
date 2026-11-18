// window.postMessage, as page code sees it natively — for every caller,
// rewritten or not.
//
// postMessage is an own property of each window (Window is a [Global]
// interface), wrapped there. targetOrigin follows HTML against the windows'
// original origins (messaging/target-origin.ts delivery). The message is
// sent through the send helper of the window whose code is calling, found
// from the call stack, so the browser stamps that window as event.source
// (and event.origin, derived from it, is the sender's original origin): a
// window posting to itself, or a caller that cannot be told, goes to the
// native from here.

import type { ClientConfig } from "../config";
import { wrapMethod } from "../native/surface";
import type { Internals } from "../native/internals";
import { callingWindow, delivery, installSender, originalOrigin, sendAs } from "../messaging/target-origin";

export function patchPostMessage(
    targetWindow: Window,
    config: ClientConfig,
    unwrap: (href: string) => string,
    internals: Internals,
): void {
    const proxyOrigin = new URL(config.apiBaseURL).origin;
    const runtimeUrl = config.apiBaseURL + config.source;
    const PE = (targetWindow as unknown as { PerformanceEntry?: { prototype: PerformanceEntry } }).PerformanceEntry;
    const nameGet = PE ? Object.getOwnPropertyDescriptor(PE.prototype, "name")?.get : undefined;
    const nameOf = (e: PerformanceEntry): string => (nameGet ? (nameGet.call(e) as string) : e.name);
    const native = wrapMethod<(...a: unknown[]) => void>(targetWindow, "postMessage", (nativeFn, self, args) => {
        const sender = callingWindow(targetWindow, runtimeUrl, nameOf, unwrap) ?? targetWindow;
        const d = delivery(self, args[1], originalOrigin(sender, unwrap), proxyOrigin, unwrap);
        if (d.kind === "drop") return;
        const next = d.kind === "send" ? [args[0], d.origin, ...args.slice(2)] : args;
        if (sender === self || sender === targetWindow && self === targetWindow) {
            return Reflect.apply(nativeFn, self, next) as void;
        }
        return sendAs(sender, self, next, () => Reflect.apply(nativeFn, self, next)) as void;
    });
    if (native) installSender(internals, native);
}
