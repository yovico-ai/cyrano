// new EventSource(url, init) and EventSource.prototype.url, as page code
// sees them natively (see websocket.ts).

import { nR, ncall } from "../native/intrinsics";
import { wrapAccessor, wrapConstructor } from "../native/surface";
import type { RewriteOne } from "./referrer-policy";

export function patchEventSource(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
    unwrapOne: (url: string) => string,
): void {
    // A credentialed one (withCredentials) is marked so: an unmarked one
    // has "same-origin" credentials (spec Cookies.elementCookies).
    const withMark = (rewriteOne as RewriteOne).withMark;
    const native = wrapConstructor<typeof EventSource>(targetWindow, "EventSource", (Native, args, newTarget) => {
        if (!args.length || typeof args[0] === "symbol") return nR.construct(Native, args, newTarget as typeof EventSource);
        let cred = false;
        try { cred = Boolean((args[1] as { withCredentials?: unknown } | undefined)?.withCredentials); } catch { cred = false; }
        const url = cred && withMark ? withMark(String(args[0]), null, "cred") : rewriteOne(String(args[0]));
        return nR.construct(Native, [url, ...args.slice(1)], newTarget as typeof EventSource);
    });
    if (native) wrapAccessor<string>(native.prototype, "url", { get: (get, self) => unwrapOne(ncall(get, self)) });
}
