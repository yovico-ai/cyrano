// document.cookie, as page code sees it natively (spec/Cookies.agda: RFC
// 6265bis with Chromium's choices; spec/CookieJar.agda: the jar).
//
// Every proxied site shares the proxy's origin, so the browser's own jar
// cannot hold the sites' cookies: it would scope them all as one site and
// cap them at one site's 180. The server keeps the session's jar; the page
// tree keeps the script-visible cookies in memory (cookies/memory.ts),
// current through the channel in the browser's jar. Reading selects, from
// memory, the cookies for the page's original URL; writing reads the
// string as the browser would, decides whether and under what scope it is
// stored, and writes memory and the outbox (on the very next request).
//
// The accessor stays the native's (Document.prototype.cookie), which is
// called first: a document that may not read cookies (sandboxed) throws as
// natively, and one without a browsing context (DOMParser's) reads "".

import { nO, ncall } from "../native/intrinsics";
import { getPublicSuffix } from "tldts";
import { parseSetCookie, selectCookies, cookieString, storeCookie } from "../cookies/rfc";
import { expiryOf, type Change } from "../cookies/jar";
import { absorbInbox, liveCookies, snapshotFirst, writeCookie, type CookieAccess } from "../cookies/memory";
import { wrapAccessor } from "../native/surface";

/** d is itself a public suffix (ICANN and private registries, as Chromium). */
export function isPublicSuffix(d: string): boolean {
    if (d === "") return false;
    return getPublicSuffix(d, { allowPrivateDomains: true }) === d;
}

/** The cookie a write of `value` at `url` makes, or null (spec store, expiryOf). */
export function cookieWrite(value: string, url: URL): Change | null {
    const sc = parseSetCookie(value);
    if (!sc) return null;
    const c = storeCookie(true, sc.domain !== null && isPublicSuffix(sc.domain), url, sc);
    if (!c) return null;
    const e = expiryOf(Date.now(), sc);
    return e === null ? { cookie: c, gone: true, expiry: { session: true } } : { cookie: c, gone: false, expiry: e };
}

/** The cookie accessor the document has (on its prototype chain), as wrapAccessor finds it. */
export function cookieAccessor(doc: object): PropertyDescriptor | undefined {
    for (let o: object | null = doc; o !== null; o = nO.getPrototypeOf(o) as object | null) {
        const d = nO.getOwnPropertyDescriptor(o, "cookie");
        if (d) return d;
    }
    return undefined;
}

export function patchDocumentCookie(targetWindow: Window, baseUrl: () => URL, only?: "get" | "set"): void {
    const desc = cookieAccessor(targetWindow.document);
    const nativeGet = desc?.get as ((this: unknown) => string) | undefined;
    const nativeSet = desc?.set as ((this: unknown, v: string) => void) | undefined;
    if (!nativeGet || !nativeSet) return;
    const access = (self: unknown): CookieAccess => ({ get: () => ncall(nativeGet, self), set: (v: string) => ncall(nativeSet, self, v) });
    const ours = (self: unknown): boolean => self === targetWindow.document;
    wrapAccessor<string>(targetWindow.document, "cookie", {
        ...(only !== "set" ? {
            get: (get: (this: unknown) => string, self: unknown) => {
                const jar = ncall(get, self);
                if (!ours(self)) return jar;
                snapshotFirst(targetWindow, baseUrl());
                const legacy = absorbInbox(targetWindow, access(self));
                return cookieString(selectCookies(true, baseUrl(), liveCookies(targetWindow, legacy)));
            },
        } : {}),
        ...(only !== "get" ? {
            set: (set: (this: unknown, v: string) => void, self: unknown, value: string) => {
                if (!ours(self)) { ncall(set, self, value); return; }
                ncall(nativeGet, self); // a document that may not write cookies throws here, as natively
                const ch = cookieWrite(String(value), baseUrl());
                if (ch === null) return;
                snapshotFirst(targetWindow, baseUrl());
                const legacy = absorbInbox(targetWindow, access(self));
                writeCookie(targetWindow, access(self), ch, legacy);
            },
        } : {}),
    });
}
