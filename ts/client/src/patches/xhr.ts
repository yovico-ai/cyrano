// Patch `XMLHttpRequest.prototype.open` so XHR URL arguments get proxified.
//
// `xhr.open(method, url, async?, user?, password?)` — we only touch the URL
// argument, all other arguments pass through with the original arity.

import { getGlobal } from "./globals";

export function patchXmlHttpRequest(
    _targetWindow: Window,
    rewriteOne: (url: string) => string,
): void {
    const XHR = getGlobal<{ prototype: XMLHttpRequest }>("XMLHttpRequest");
    if (!XHR?.prototype) return;

    const proto = XHR.prototype;
    const originalOpen = proto.open;

    proto.open = function patchedOpen(
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        ...rest: unknown[]
    ): void {
        const rawUrl = typeof url === "string" ? url : url.href;
        const proxified = rewriteOne(rawUrl);
        return (originalOpen as (...args: unknown[]) => void).call(
            this,
            method,
            proxified,
            ...rest,
        );
    } as typeof proto.open;
}
