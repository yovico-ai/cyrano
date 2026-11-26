// XMLHttpRequest.prototype.open and .responseURL, as page code sees them
// natively. open(method, url, …): only the URL is proxified; the receiver
// and the arity reach the native unchanged. responseURL reads back the
// original URL. A request to another origin names the requesting origin
// to the proxy (cors.ts).

import { documentQueryEncoder, requery } from "../url/doc-query";
import { SafeWeakMap, SafeWeakSet, nO, nR, ncall, sLower, sStarts } from "../native/intrinsics";
import { wrapAccessor, wrapMethod } from "../native/surface";
import { AUTHORS, CREDENTIALS, INITIATOR, KIND, crossOriginXhr, xhrOrigin, namesContext, initiatorValue, initiatorOfXhr, isCrossOrigin, type CorsContext } from "./cors";

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
    const setHeader = proto.setRequestHeader; // the native, for the runtime's own headers
    // The header names the page sets (since open), and whether its upload
    // object has listeners — what decides a CORS preflight (cors.ts AUTHORS).
    const authorNames = new SafeWeakMap<object, string[]>();
    const uploads = new SafeWeakMap<object, object>(); // upload object → its XHR
    const listened = new SafeWeakSet<object>();        // XHRs whose upload has listeners
    const uploadGet = nO.getOwnPropertyDescriptor(proto, "upload")?.get as ((this: unknown) => object) | undefined;
    if (uploadGet) {
        wrapAccessor<unknown>(proto, "upload", {
            get: (get, self) => {
                const u = ncall(get, self) as object;
                if (u && typeof self === "object" && self !== null) uploads.set(u, self as object);
                return u;
            },
        });
    }
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    const ET = g["EventTarget"]?.prototype;
    if (ET && uploadGet) {
        wrapMethod<(...a: unknown[]) => unknown>(ET, "addEventListener", (native, self, args) => {
            const r = nR.apply(native, self, args);
            const x = typeof self === "object" && self !== null ? uploads.get(self) : undefined;
            if (x && (typeof args[1] === "function" || (typeof args[1] === "object" && args[1] !== null))) listened.add(x);
            return r;
        });
    }
    const XET = g["XMLHttpRequestEventTarget"]?.prototype;
    if (XET && uploadGet) {
        for (const k of ["onloadstart", "onprogress", "onabort", "onerror", "onload", "ontimeout", "onloadend"]) {
            if (!nO.getOwnPropertyDescriptor(XET, k)?.set) continue;
            wrapAccessor<unknown>(XET, k, {
                set: (set, self, v) => {
                    ncall(set, self, v);
                    const x = typeof self === "object" && self !== null ? uploads.get(self) : undefined;
                    if (x && typeof v === "function") listened.add(x);
                },
            });
        }
    }
    wrapMethod<(...a: unknown[]) => void>(proto, "setRequestHeader", (native, self, args) => {
        const r = nR.apply(native, self, args) as void; // the native's checks (state, name) first
        if (typeof self === "object" && self !== null && args.length > 0) {
            const list = authorNames.get(self) ?? [];
            list[list.length] = sLower(String(args[0]));
            authorNames.set(self, list);
        }
        return r;
    });
    wrapMethod<(...a: unknown[]) => void>(proto, "open", (native, self, args) => {
        if (typeof self === "object" && self !== null) authorNames.delete(self);
        if (args.length < 2 || typeof args[1] === "symbol") return nR.apply(native, self, args) as void; // the native's own TypeError
        const next = args.slice();
        const given = String(args[1]);
        // (a legacy-encoded document's query in its encoding: spec/Encoding.agda)
        const enc = documentQueryEncoder(targetWindow);
        next[1] = enc ? requery(rewriteOne(given), given, enc) : rewriteOne(given);
        const done = nR.apply(native, self, next) as void;
        // Opened: note whether it goes to another origin (cors.ts).
        if (cors && baseUrl && typeof self === "object" && self !== null) {
            const own = cors.origin();
            const target = unwrapOne(String(next[1]));
            const cross = isCrossOrigin(target, baseUrl(), own) && !(cors.proxy && sStarts(target, cors.proxy + "/"));
            if (cross) crossOriginXhr.set(self, own); else crossOriginXhr.delete(self);
            xhrOrigin.set(self, own);
            if (namesContext(cors.opaque === true, cross, cors.always === true, true)) initiatorOfXhr.set(self, { href: initiatorValue(cors.href()), cross });
            else initiatorOfXhr.delete(self);
        }
        return done;
    });
    const withCredentials = nO.getOwnPropertyDescriptor(proto, "withCredentials")?.get as ((this: unknown) => boolean) | undefined;
    wrapMethod<(...a: unknown[]) => void>(proto, "send", (native, self, args) => {
        const from = typeof self === "object" && self !== null ? initiatorOfXhr.get(self) : undefined;
        // Tell the proxy it is an XHR: Chrome sends an XHR's page-set
        // headers first (Go headerorder.ChromeDefault). Not from an opaque
        // context: there the browser runs CORS, and the header would force
        // a preflight.
        if (cors && cors.opaque !== true) {
            try { ncall(setHeader, self, KIND, "xhr"); } catch { /* not opened: the native send throws */ }
        }
        if (from && from.href) {
            try {
                const names = typeof self === "object" && self !== null ? authorNames.get(self) ?? [] : [];
                const force = typeof self === "object" && self !== null && listened.has(self) && args[0] != null ? ["!"] : [];
                ncall(setHeader, self, AUTHORS, [...names, ...force].join(","));
                ncall(setHeader, self, INITIATOR, from.href);
                // An XHR's credentials mode: "include" with withCredentials, else "same-origin".
                const mode = withCredentials && ncall(withCredentials, self) ? "include" : "same-origin";
                ncall(setHeader, self, CREDENTIALS, mode);
            } catch { /* not opened: the native send throws */ }
        }
        return nR.apply(native, self, args) as void;
    });
    wrapAccessor<string>(proto, "responseURL", { get: (get, self) => unwrapOne(ncall(get, self)) });
}
