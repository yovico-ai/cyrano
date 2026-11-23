// new WebSocket(url, protocols) and WebSocket.prototype.url, as page code
// sees them natively: the constructor is the native's (statics, prototype,
// "use the 'new' operator" TypeError, subclassing) with only the URL
// proxified; url reads back the original.
//
// A WebSocket handshake carries no Referer, so the server cannot know which
// page opened the socket, and with it the Origin a direct browser would
// send. The proxied URL therefore names the page's origin in a reserved
// last query parameter (Go urlrewrite.WSOriginParam), which the server
// strips before the upstream sees the URL and which url never shows.

import { nR, ncall, sIncludes } from "../native/intrinsics";
import { wrapAccessor, wrapConstructor } from "../native/surface";

export const WS_ORIGIN_PARAM = "__cyrano_ws_origin";

/** Appends the origin marker to a proxied WebSocket URL. */
export function withPageOrigin(proxied: string, pageOrigin: string): string {
    if (sIncludes(proxied, "#")) return proxied; // the native rejects a fragment itself
    const sep = sIncludes(proxied, "?") ? "&" : "?";
    return `${proxied}${sep}${WS_ORIGIN_PARAM}=${encodeURIComponent(pageOrigin)}`;
}

/** Removes the marker: exactly the inverse of withPageOrigin. */
export function withoutPageOrigin(url: string): string {
    const m = new RegExp(`([?&])${WS_ORIGIN_PARAM}=[^&#]*$`).exec(url);
    return m ? url.slice(0, m.index) : url;
}

export function patchWebSocket(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
    unwrapOne: (url: string) => string,
    pageOrigin: () => string = () => "",
): void {
    const native = wrapConstructor<typeof WebSocket>(targetWindow, "WebSocket", (Native, args, newTarget) => {
        if (!args.length) return nR.construct(Native, args, newTarget as typeof WebSocket);
        const raw = String(args[0]);
        const proxied = rewriteOne(raw);
        const origin = pageOrigin();
        const url = proxied !== raw && origin ? withPageOrigin(proxied, origin) : proxied;
        return nR.construct(Native, [url, ...args.slice(1)], newTarget as typeof WebSocket);
    });
    if (native) {
        wrapAccessor<string>(native.prototype, "url", {
            get: (get, self) => {
                const real = ncall(get, self);
                const bare = withoutPageOrigin(real);
                // The browser made the proxied URL ws: / wss: (from the proxy's
                // http: / https:): read back as the proxy's, then the page's
                // made ws: / wss: as the browser makes it (toutiao.com read
                // wss://<proxy>/cyrano/https/… back).
                const asProxy = bare.replace(/^ws(s?):/i, (_m, s: string) => `http${s}:`);
                const original = unwrapOne(asProxy);
                // Only a URL cyrano proxified carries cyrano's marker.
                if (original === asProxy) return real;
                return original.replace(/^http(s?):/i, (_m, s: string) => `ws${s}:`);
            },
        });
    }
}
