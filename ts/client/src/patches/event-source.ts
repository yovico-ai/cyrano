// new EventSource(url, init) and EventSource.prototype.url, as page code
// sees them natively (see websocket.ts).

import { nR, ncall } from "../native/intrinsics";
import { wrapAccessor, wrapConstructor } from "../native/surface";

export function patchEventSource(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
    unwrapOne: (url: string) => string,
): void {
    const native = wrapConstructor<typeof EventSource>(targetWindow, "EventSource", (Native, args, newTarget) =>
        nR.construct(Native, args.length ? [rewriteOne(String(args[0])), ...args.slice(1)] : args, newTarget as typeof EventSource));
    if (native) wrapAccessor<string>(native.prototype, "url", { get: (get, self) => unwrapOne(ncall(get, self)) });
}
