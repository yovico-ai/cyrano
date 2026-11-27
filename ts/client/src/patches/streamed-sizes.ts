// The origin's sizes of a body the proxy streamed (Go: server/stream.go).
// Its crnb metric carries a token (spec/Carry.agda crnbRef), not the
// sizes: they are known only when the body has ended, and come in the
// session's next response as a cookie of the channel — "__crn~z!" token
// = "<encoded>-<decoded>" (spec sizesCookie; Go proxy.SizesCookie) — read
// here from the browser's own jar. Until it has come, a size reads the
// browser's own value (natively a body still arriving reads 0 too). No
// request is made for them (a page's CSP refused one; a sandboxed frame
// failed CORS); no page reads the channel (document-cookie.ts lists none
// of its names).

import { SafeMap, SafeWeakMap, nO, ncall, sStarts } from "../native/intrinsics";
import { sharedData } from "../native/shared";
import { crnbSizes } from "./install";

export type Sizes = { encoded: number; decoded: number };

/** The cookie's prefix (spec sizesCookiePrefix). */
export const SIZES_COOKIE = "__crn~z!";

export function streamedSizes(targetWindow: Window): { get(token: string): Sizes | null } {
    const known = new SafeMap<string, Sizes>();
    // The browser's own cookie getter: the pristine one the page tree keeps
    // (document-cookie.ts), else this realm's as it is now (before page code).
    const own = (() => {
        for (let o: object | null = (targetWindow as unknown as { Document?: { prototype: object } }).Document?.prototype ?? null; o; o = nO.getPrototypeOf(o) as object | null) {
            const d = nO.getOwnPropertyDescriptor(o, "cookie");
            if (d?.get) return d.get as (this: unknown) => string;
        }
        return undefined;
    })();
    const nativeGet = (): ((this: unknown) => string) | undefined => {
        let top: object = targetWindow;
        try { top = (targetWindow.top as object | null) ?? targetWindow; } catch { top = targetWindow; }
        const trees = sharedData("cookiePristine", () => new SafeWeakMap<object, { get: (this: unknown) => string; set: (this: unknown, v: string) => void }>());
        return trees.get(top)?.get ?? own;
    };
    const read = (): void => {
        const get = nativeGet();
        if (!get) return;
        let jar = "";
        try { jar = ncall(get, targetWindow.document); } catch { return; } // (an opaque origin: none)
        for (const part of jar.split(";")) {
            const p = part.trim();
            if (!sStarts(p, SIZES_COOKIE)) continue;
            const eq = p.indexOf("=");
            if (eq < 0) continue;
            const sizes = crnbSizes(p.slice(eq + 1));
            if (sizes) known.set(p.slice(SIZES_COOKIE.length, eq), sizes);
        }
    };
    return {
        get(token) {
            let s = known.get(token);
            if (s) return s;
            read();
            s = known.get(token);
            return s ?? null;
        },
    };
}
