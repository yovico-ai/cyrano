// A URL's query in a legacy-encoded document (spec/Encoding.agda): the
// browser encodes an element URL's, a navigation's and XHR's query in the
// document's encoding — through the proxy the URL parser was handed the
// proxified URL, whose query came out in UTF-8. The input's own query is
// encoded as the document's (by the browser itself: an anchor of that
// document) and put in place of the proxified URL's.

import { SafeWeakMap, nO, ncall } from "../native/intrinsics";

/** An input URL's own query: after the first "?", before "#", tabs and newlines removed (null: none). */
export function rawQuery(input: string): string | null {
    let s = input.replace(/[\t\n\r]/g, "");
    const h = s.indexOf("#");
    if (h >= 0) s = s.slice(0, h);
    const q = s.indexOf("?");
    return q < 0 ? null : s.slice(q + 1);
}

/** The proxified URL with the input's query encoded by `encode`, when that query holds a code point beyond ASCII. */
export function requery(proxified: string, input: string, encode: (q: string) => string): string {
    const q = rawQuery(input);
    if (q === null || !/[^\x00-\x7f]/.test(q)) return proxified;
    const i = proxified.indexOf("?");
    if (i < 0) return proxified;
    const h = proxified.indexOf("#", i);
    return proxified.slice(0, i + 1) + encode(q) + (h < 0 ? "" : proxified.slice(h));
}

/** spec encodeQuery, with an encoder (tests: the latin1 model; pages: the browser's). */
export function encodeQuery(enc: (cp: number) => number[] | null, special: boolean, q: string): string {
    let out = "";
    for (const ch of q) {
        const cp = ch.codePointAt(0)!;
        let bytes = enc(cp);
        if (bytes === null) bytes = [...`&#${cp};`].map((c) => c.charCodeAt(0));
        for (const b of bytes) {
            const enc2 = b < 33 || b === 0x22 || b === 0x23 || b === 0x3c || b === 0x3e || b >= 127 || (special && b === 0x27);
            out += enc2 ? "%" + (b >> 4).toString(16).toUpperCase() + (b & 15).toString(16).toUpperCase() : String.fromCharCode(b);
        }
    }
    return out;
}

export const latin1 = (cp: number): number[] | null => (cp < 256 ? [cp] : null);

// The anchor's natives, per window, captured before the runtime wraps them.
const natives = new SafeWeakMap<object, { hrefSet: (this: unknown, v: string) => void; searchGet: (this: unknown) => string; charset: (this: unknown) => string; create: (this: unknown, t: string) => Element }>();

/** Records the window's natives this needs (call before the URL attribute patches). */
export function initDocumentQuery(win: Window): void {
    try {
        const g = win as unknown as Record<string, { prototype: object } | undefined>;
        const A = g["HTMLAnchorElement"]?.prototype, D = g["Document"]?.prototype;
        if (!A || !D) return;
        const find = (o: object | null, k: string): PropertyDescriptor | undefined => {
            for (; o; o = nO.getPrototypeOf(o) as object | null) { const d = nO.getOwnPropertyDescriptor(o, k); if (d) return d; }
            return undefined;
        };
        const hrefSet = find(A, "href")?.set, searchGet = find(A, "search")?.get, charset = find(D, "characterSet")?.get;
        const create = find(D, "createElement")?.value;
        if (hrefSet && searchGet && charset && typeof create === "function") {
            natives.set(win, { hrefSet: hrefSet as never, searchGet: searchGet as never, charset: charset as never, create: create as never });
        }
    } catch { /* none: queries stay UTF-8 */ }
}

const encoders = new SafeWeakMap<object, ((q: string) => string) | null>();

/**
 * The query encoder of the window's document: null for a UTF-8 document
 * (nothing to do); else the browser's own, through an anchor of it.
 */
export function documentQueryEncoder(win: Window): ((q: string) => string) | null {
    const n = natives.get(win);
    let doc: Document;
    try { doc = win.document; } catch { return null; }
    if (!n || !doc) return null;
    if (encoders.has(doc)) return encoders.get(doc) ?? null;
    let f: ((q: string) => string) | null = null;
    try {
        const cs = String(ncall(n.charset, doc));
        if (cs.toUpperCase() !== "UTF-8") {
            const a = ncall(n.create, doc, "a");
            f = (q) => { ncall(n.hrefSet, a, "http://crn.invalid/?" + q); return String(ncall(n.searchGet, a)).slice(1); };
        }
    } catch { f = null; }
    encoders.set(doc, f);
    return f;
}
