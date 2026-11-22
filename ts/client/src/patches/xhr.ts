// XMLHttpRequest.prototype.open and .responseURL, as page code sees them
// natively. open(method, url, …): only the URL is proxified; the receiver
// and the arity reach the native unchanged. responseURL reads back the
// original URL. A request to another origin names the requesting origin
// to the proxy (cors.ts).

import { nO, nR, ncall, sStarts } from "../native/intrinsics";
import { wrapAccessor, wrapMethod } from "../native/surface";
import { CREDENTIALS, INITIATOR, crossOriginXhr, namesContext, includesCredentials, initiatorValue, initiatorOfXhr, isCrossOrigin, type CorsContext } from "./cors";

export function patchXmlHttpRequest(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
    unwrapOne: (url: string) => string,
    baseUrl?: () => URL,
    cors?: CorsContext,
): void {
    const XHR = (targetWindow as unknown as { XMLHttpRequest?: { prototype: XMLHttpRequest } }).XMLHttpRequest;
    if (!XHR?.prototype) return;
    const proto = XHR.prototype;
    wrapMethod<(...a: unknown[]) => void>(proto, "open", (native, self, args) => {
        if (args.length < 2) return nR.apply(native, self, args) as void; // the native's own TypeError
        const next = args.slice();
        next[1] = rewriteOne(String(args[1]));
        const done = nR.apply(native, self, next) as void;
        // Opened: note whether it goes to another origin (cors.ts).
        if (cors && baseUrl && typeof self === "object" && self !== null) {
            const own = cors.origin();
            const target = unwrapOne(String(next[1]));
            const cross = isCrossOrigin(target, baseUrl(), own) && !(cors.proxy && sStarts(target, cors.proxy + "/")) &&
                (cors.sameHost === undefined || cors.sameHost(String(next[1])));
            if (cross) crossOriginXhr.set(self, own); else crossOriginXhr.delete(self);
            if (namesContext(cors.opaque === true, cross, cors.always === true)) initiatorOfXhr.set(self, { href: initiatorValue(cors.href()), cross });
            else initiatorOfXhr.delete(self);
        }
        return done;
    });
    const setHeader = proto.setRequestHeader;
    const withCredentials = nO.getOwnPropertyDescriptor(proto, "withCredentials")?.get as ((this: unknown) => boolean) | undefined;
    wrapMethod<(...a: unknown[]) => void>(proto, "send", (native, self, args) => {
        const from = typeof self === "object" && self !== null ? initiatorOfXhr.get(self) : undefined;
        if (from && from.href) {
            try {
                ncall(setHeader, self, INITIATOR, from.href);
                // An XHR's credentials mode: "include" with withCredentials, else "same-origin".
                const mode = withCredentials && ncall(withCredentials, self) ? "include" : "same-origin";
                ncall(setHeader, self, CREDENTIALS, includesCredentials(mode, !from.cross) ? "include" : "omit");
            } catch { /* not opened: the native send throws */ }
        }
        return nR.apply(native, self, args) as void;
    });
    wrapAccessor<string>(proto, "responseURL", { get: (get, self) => unwrapOne(ncall(get, self)) });
}
