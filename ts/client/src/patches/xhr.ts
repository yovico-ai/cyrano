// XMLHttpRequest.prototype.open and .responseURL, as page code sees them
// natively. open(method, url, …): only the URL is proxified; the receiver
// and the arity reach the native unchanged. responseURL reads back the
// original URL.

import { wrapAccessor, wrapMethod } from "../native/surface";

export function patchXmlHttpRequest(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
    unwrapOne: (url: string) => string,
): void {
    const XHR = (targetWindow as unknown as { XMLHttpRequest?: { prototype: XMLHttpRequest } }).XMLHttpRequest;
    if (!XHR?.prototype) return;
    const proto = XHR.prototype;
    wrapMethod<(...a: unknown[]) => void>(proto, "open", (native, self, args) => {
        if (args.length < 2) return Reflect.apply(native, self, args) as void; // the native's own TypeError
        const next = args.slice();
        next[1] = rewriteOne(String(args[1]));
        return Reflect.apply(native, self, next) as void;
    });
    wrapAccessor<string>(proto, "responseURL", { get: (get, self) => unwrapOne(get.call(self)) });
}
