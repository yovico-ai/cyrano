// MessageEvent.prototype.origin, as page code sees it natively: the
// sender's origin. Every proxied frame really lives on the proxy origin, so
// a message between them arrives stamped with it; the getter answers the
// sending window's original origin instead (messaging/target-origin.ts).
// Events from windows cyrano does not proxy keep the native value.
//
// One accessor on the prototype covers addEventListener and onmessage
// alike, and leaves the event object itself the native one.

import { nO, ncall } from "../native/intrinsics";
import type { ClientConfig } from "../config";
import { unwrapProxiedUrl } from "../url/containment";
import { wrapAccessor } from "../native/surface";
import { originalOrigin } from "../messaging/target-origin";

export function patchMessageEventOrigin(targetWindow: Window, config: ClientConfig): void {
    const ME = (targetWindow as unknown as { MessageEvent?: { prototype: MessageEvent } }).MessageEvent;
    if (!ME?.prototype) return;
    const proxyOrigin = new URL(config.apiBaseURL).origin;
    const unwrap = (h: string) => unwrapProxiedUrl(h, config);
    const sourceGet = nO.getOwnPropertyDescriptor(ME.prototype, "source")?.get;
    wrapAccessor<string>(ME.prototype, "origin", {
        get: (get, self) => {
            const origin = ncall(get, self);
            if (origin !== proxyOrigin || !sourceGet) return origin;
            const source = ncall(sourceGet, self) as unknown;
            return (source ? originalOrigin(source, unwrap) : null) ?? origin;
        },
    });
}

// Exported for unit testing only.
export function upstreamOriginOf(source: Window, config: ClientConfig): string | null {
    return originalOrigin(source, (h) => unwrapProxiedUrl(h, config));
}
