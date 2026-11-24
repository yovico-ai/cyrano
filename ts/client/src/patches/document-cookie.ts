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
import { inCtx, parseSetCookie, placedIn, selectCookies, cookieString, storableIn, storeCookie, type CookieCtx } from "../cookies/rfc";
import { expiryOf, type Change } from "../cookies/jar";
import { absorbInbox, cookieCtxOf, liveCookies, snapshotFirst, writeCookie, type CookieAccess } from "../cookies/memory";
import { wrapAccessor } from "../native/surface";

/** d is itself a public suffix (ICANN and private registries, as Chromium). */
export function isPublicSuffix(d: string): boolean {
    if (d === "") return false;
    return getPublicSuffix(d, { allowPrivateDomains: true }) === d;
}

/** Now, in ms to the microsecond (Chromium's clock). */
export function nowMicro(): number {
    try {
        const p = performance;
        return Math.round((p.timeOrigin + p.now()) * 1000) / 1000;
    } catch { return Date.now(); }
}

/** The cookie a write of `value` at `url` makes, or null (spec store, expiryOf). */
export function cookieWrite(value: string, url: URL, ctx: CookieCtx | null = null): Change | null {
    const sc = parseSetCookie(value);
    if (!sc) return null;
    const c0 = storeCookie(true, sc.domain !== null && isPublicSuffix(sc.domain), url, sc);
    if (!c0) return null;
    // The document's context: a cross-site one stores SameSite=None only, a
    // Partitioned cookie under its key (spec storableIn, placedIn).
    if (ctx !== null && !storableIn(ctx, sc)) return null;
    const c = ctx !== null ? placedIn(ctx, sc, c0) : c0;
    // Chromium's clock has microseconds: an expiry from Max-Age reads back
    // with them (cookieStore's expires: 1795476386877.137).
    const e = expiryOf(nowMicro(), sc);
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
    // Another window's document (this realm's accessor called on it — a
    // script that takes its natives from a frame: Quantum Metric): its own
    // window's accessor serves it, which keeps that window's cookies.
    const viewDesc = (() => { for (let o: object | null = targetWindow.document; o; o = nO.getPrototypeOf(o) as object | null) { const d = nO.getOwnPropertyDescriptor(o, "defaultView"); if (d) return d; } return undefined; })();
    const theirs = (self: unknown): PropertyDescriptor | undefined => {
        try {
            const w = viewDesc?.get ? (ncall(viewDesc.get as (this: unknown) => unknown, self) as Window | null) : null;
            if (!w || w === targetWindow) return undefined;
            const d = cookieAccessor(w.document);
            return d && d.get !== desc?.get ? d : undefined;
        } catch { return undefined; }
    };
    // This realm's own wrapped accessor (once installed): never handed back to itself.
    const wrappedGet = (): unknown => cookieAccessor(targetWindow.document)?.get;
    const wrappedSet = (): unknown => cookieAccessor(targetWindow.document)?.set;
    wrapAccessor<string>(targetWindow.document, "cookie", {
        ...(only !== "set" ? {
            get: (get: (this: unknown) => string, self: unknown) => {
                if (!ours(self)) {
                    const d = theirs(self);
                    if (d?.get && d.get !== wrappedGet()) return ncall(d.get as (this: unknown) => string, self);
                    return ncall(get, self);
                }
                ncall(get, self); // a document that may not read cookies throws here, as natively
                snapshotFirst(targetWindow, baseUrl());
                const legacy = absorbInbox(targetWindow, access(self));
                const cx = cookieCtxOf(targetWindow);
                return cookieString(selectCookies(true, baseUrl(), liveCookies(targetWindow, legacy).filter((c) => cx === null || inCtx(true, cx, c))));
            },
        } : {}),
        ...(only !== "get" ? {
            set: (set: (this: unknown, v: string) => void, self: unknown, value: string) => {
                if (!ours(self)) {
                    const d = theirs(self);
                    if (d?.set && d.set !== wrappedSet()) { ncall(d.set as (this: unknown, v: string) => void, self, value); return; }
                    ncall(set, self, value);
                    return;
                }
                ncall(nativeGet, self); // a document that may not write cookies throws here, as natively
                const ch = cookieWrite(String(value), baseUrl(), cookieCtxOf(targetWindow));
                if (ch === null) return;
                snapshotFirst(targetWindow, baseUrl());
                const legacy = absorbInbox(targetWindow, access(self));
                writeCookie(targetWindow, access(self), ch, legacy);
            },
        } : {}),
    });
}
