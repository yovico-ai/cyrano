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
    // A stream's message (EventSource, WebSocket) has the stream URL's
    // origin (spec/Messaging.agda streamOrigin; round H/K: the proxy's, and
    // its ws: one). The url getters are the runtime's (installed before
    // this): they read the page's URL back.
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    const targetGet = g["Event"] ? nO.getOwnPropertyDescriptor(g["Event"].prototype, "target")?.get : undefined;
    const urlGets = ["EventSource", "WebSocket"].flatMap((k) => {
        const d = g[k] ? nO.getOwnPropertyDescriptor(g[k]!.prototype, "url")?.get : undefined;
        return d ? [d] : [];
    });
    const wsProxyOrigin = proxyOrigin.replace(/^http/, "ws");
    const ofStream = (self: unknown): string | null => {
        if (!targetGet) return null;
        const t = ncall(targetGet, self) as object | null;
        if (!t) return null;
        for (const u of urlGets) {
            let raw: unknown;
            try { raw = ncall(u, t); } catch { continue; } // not this kind of stream
            return typeof raw === "string" ? streamOriginOf(raw) : null;
        }
        return null;
    };
    wrapAccessor<string>(ME.prototype, "origin", {
        get: (get, self) => {
            const origin = ncall(get, self);
            if (origin !== proxyOrigin && origin !== wsProxyOrigin) return origin;
            const stream = ofStream(self);
            if (stream !== null) return stream;
            if (origin !== proxyOrigin || !sourceGet) return origin;
            const source = ncall(sourceGet, self) as unknown;
            return (source ? originalOrigin(source, unwrap) : null) ?? origin;
        },
    });
}

/** spec/Messaging.agda streamOrigin: a stream URL's origin, or null where it has no tuple origin. */
export function streamOriginOf(url: string): string | null {
    try {
        const u = new URL(url);
        return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "ws:" || u.protocol === "wss:" ? u.origin : null;
    } catch {
        return null;
    }
}

// Exported for unit testing only.
export function upstreamOriginOf(source: Window, config: ClientConfig): string | null {
    return originalOrigin(source, (h) => unwrapProxiedUrl(h, config));
}
