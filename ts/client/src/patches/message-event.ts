// MessageEvent.prototype.origin, as page code sees it natively: the
// sender's origin. Every proxied frame really lives on the proxy origin, so
// a message between them arrives stamped with it; the getter answers the
// sending window's original origin instead (messaging/target-origin.ts).
// Events from windows cyrano does not proxy keep the native value.
//
// One accessor on the prototype covers addEventListener and onmessage
// alike, and leaves the event object itself the native one.

import { nO, ncall, sEnds, sStarts } from "../native/intrinsics";
import type { ClientConfig } from "../config";
import { unwrapProxiedUrl } from "../url/containment";
import { wrapAccessor } from "../native/surface";
import { originalOrigin } from "../messaging/target-origin";
import { originOfHost } from "../url/site-host";

export function patchMessageEventOrigin(targetWindow: Window, config: ClientConfig): void {
    const ME = (targetWindow as unknown as { MessageEvent?: { prototype: MessageEvent } }).MessageEvent;
    if (!ME?.prototype) return;
    const proxyOrigin = new URL(config.apiBaseURL).origin;
    const unwrap = (h: string) => unwrapProxiedUrl(h, config);
    const sourceGet = nO.getOwnPropertyDescriptor(ME.prototype, "source")?.get;
    const proxyHost = new URL(config.apiBaseURL).host, proxyScheme = new URL(config.apiBaseURL).protocol;
    // Host mode: any of the proxy's hosts is ours (each site on its own).
    const ours = (o: string): boolean => o === proxyOrigin ||
        (config.sites === true && sStarts(o, proxyScheme + "//") && sEnds(o, "." + proxyHost));
    wrapAccessor<string>(ME.prototype, "origin", {
        get: (get, self) => {
            const origin = ncall(get, self);
            if (!ours(origin) || !sourceGet) return origin;
            const source = ncall(sourceGet, self) as unknown;
            // The sender's window when it can be read; else what it announced (site-messages.ts).
            // Host mode: the origin the host's label names (a cross-origin sender cannot be read).
            const fromHost = (): string | null => { try { return originOfHost(new URL(origin).host, proxyHost); } catch { return null; } };
            return (source ? originalOrigin(source, unwrap) : null) ?? (config.sites === true ? fromHost() : null) ?? origin;
        },
    });
}

// Exported for unit testing only.
export function upstreamOriginOf(source: Window, config: ClientConfig): string | null {
    return originalOrigin(source, (h) => unwrapProxiedUrl(h, config));
}
