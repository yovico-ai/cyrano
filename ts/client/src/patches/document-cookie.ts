// Patch document.cookie to enforce per-site cookie namespacing.
//
// The proxy stores upstream cookies under the proxy origin (localhost) with a
// site-namespace prefix: e.g. ak_bmsc=xxx from casio.com is stored as
// __crn__casio_com__ak_bmsc=xxx.  Without this patch, page JavaScript that
// reads or writes document.cookie would see the raw prefixed names — Akamai's
// bot JS would fail to read its own bm_sv cookie, causing re-challenges.
//
// Getter: returns only cookies belonging to the current upstream site, with
//         the prefix stripped, so page JS sees plain "ak_bmsc=xxx; bm_sv=yyy".
//
// Setter: prefixes the cookie name before writing to the real cookie store so
//         the proxy's Director can later filter and forward it correctly.

import { cookiePrefixFor } from "../cookies/site-key";

export function patchDocumentCookie(
    targetWindow: Window,
    getCurrentHost: () => string,
): void {
    const doc = targetWindow.document;

    // Walk the full prototype chain to find where "cookie" is defined.
    // In Chrome, document.cookie lives on Document.prototype, not on
    // HTMLDocument.prototype (the immediate prototype of the document instance),
    // so a single getOwnPropertyDescriptor(Object.getPrototypeOf(doc)) misses it.
    let descriptor: PropertyDescriptor | undefined;
    let proto: object | null = doc;
    while (proto) {
        const d = Object.getOwnPropertyDescriptor(proto, "cookie");
        if (d?.get && d.set) { descriptor = d; break; }
        proto = Object.getPrototypeOf(proto);
    }

    if (!descriptor?.get || !descriptor.set) return;

    const nativeGet = descriptor.get;
    const nativeSet = descriptor.set;

    Object.defineProperty(doc, "cookie", {
        get(): string {
            const raw: string = nativeGet.call(this);
            if (!raw) return "";
            const prefix = cookiePrefixFor(getCurrentHost());
            return raw
                .split(";")
                .map((c) => c.trim())
                .filter((c) => c.startsWith(prefix))
                .map((c) => c.slice(prefix.length))
                .join("; ");
        },
        set(value: string): void {
            const prefix = cookiePrefixFor(getCurrentHost());
            nativeSet.call(this, prefixCookieName(value, prefix));
        },
        configurable: true,
        enumerable: true,
    });
}

// prefixCookieName inserts prefix before the cookie name in a Set-Cookie-style
// assignment string ("name=value; Path=/; ...").
export function prefixCookieName(cookieStr: string, prefix: string): string {
    const semi = cookieStr.indexOf(";");
    const nameValue = semi >= 0 ? cookieStr.slice(0, semi) : cookieStr;
    const attrs = semi >= 0 ? cookieStr.slice(semi) : "";
    return prefix + nameValue.trimStart() + attrs;
}
