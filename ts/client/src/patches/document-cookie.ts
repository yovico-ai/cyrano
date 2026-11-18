// document.cookie, as page code sees it natively (spec/Cookies.agda: RFC
// 6265bis with Chromium's choices).
//
// Every proxied site shares the proxy's origin, so the browser's own cookie
// scoping cannot tell sites apart. A script-visible cookie lives in the
// browser's own jar — a write is on the very next request, a response's
// Set-Cookie shows here at once, tabs agree — under a wire name that carries
// its scope (cookies/rfc.ts). Reading selects, from the jar, the cookies for
// the page's original URL; writing reads the string as the browser would,
// decides whether and under what scope it is stored, and writes the wire
// form. Expiry attributes go to the browser as written: it applies its own
// cookie-date and Max-Age rules, as natively.
//
// The accessor stays the native's (Document.prototype.cookie).

import { getPublicSuffix } from "tldts";
import { cookiesFor, parseSetCookie, storeCookie, wireName, wireValue } from "../cookies/rfc";
import { wrapAccessor } from "../native/surface";

/** d is itself a public suffix (ICANN and private registries, as Chromium). */
export function isPublicSuffix(d: string): boolean {
    if (d === "") return false;
    return getPublicSuffix(d, { allowPrivateDomains: true }) === d;
}

/** What a write of `value` at `url` stores in the browser's jar, or null. */
export function nativeCookieWrite(value: string, url: URL): string | null {
    const sc = parseSetCookie(value);
    if (!sc) return null;
    const c = storeCookie(true, sc.domain !== null && isPublicSuffix(sc.domain), url, sc);
    if (!c) return null;
    let out = `${wireName(c)}=${wireValue(c)}; Path=/`;
    if (sc.expires !== null) out += `; Expires=${sc.expires}`;
    if (sc.maxAge !== null) out += `; Max-Age=${sc.maxAge}`;
    return out;
}

export function patchDocumentCookie(targetWindow: Window, baseUrl: () => URL, only?: "get" | "set"): void {
    wrapAccessor<string>(targetWindow.document, "cookie", {
        ...(only !== "set" ? { get: (get: (this: unknown) => string, self: unknown) => cookiesFor(true, baseUrl(), get.call(self)) } : {}),
        ...(only !== "get" ? {
            set: (set: (this: unknown, v: string) => void, self: unknown, value: string) => {
                const w = nativeCookieWrite(String(value), baseUrl());
                if (w !== null) set.call(self, w);
            },
        } : {}),
    });
}
