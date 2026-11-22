// What the page builds in the browser and hands an element as a blob: URL
// never passes the server, so the URLs inside it went to their origins:
//   * a frame's HTML document (TradingView's chart on bitrue.com:
//     `<iframe src="blob:…">` of a page it writes);
//   * a stylesheet (monotote's theme on sneakernews.com:
//     `link.rel = "stylesheet"; link.href = URL.createObjectURL(css)`).
// The element gets instead a blob: URL of the same content rewritten — a
// document as a srcdoc is (URLs proxified, the runtime's bootstrap first),
// a stylesheet as any CSS — of the same type (spec/Frames.agda
// blobDocument, blobBase). The page reads back the URL it gave.
//
// A blob: URL cannot be a base (its path is opaque): in a blob document a
// reference without a scheme resolves to nothing directly (relative, "/x",
// "//h/x" alike), and is left as written, so it fails proxied too; a
// <base href> that cannot resolve is passed over, the first that does is
// the base from there on (measured in Chromium). A blob stylesheet's
// references resolve against the document's base (measured), as any
// sheet's are rewritten. Known gap: a blob sheet @imported by another.
//
// Read synchronously with the XHR saved at load, as a blob worker's script
// is (blob-worker-source.ts). Known gap: the frame's own location reads the
// rewritten blob: URL.

import { SafeMap, nO, ncall, sStarts } from "../native/intrinsics";
import { rewriteCssText } from "../css/rewriter";
import { readBlob } from "./blob-worker-source";
import { rewriteSrcdoc } from "./html-rewriter";
import type { RewriteOne } from "./referrer-policy";

const done = new SafeMap<string, string>(); // "doc|css " + the page's blob URL → the rewritten one's

/** Whether a blob's type is one Chromium renders as an HTML document (spec/Frames.agda blobDocument). */
export function htmlDocumentType(type: string): boolean {
    // Before any ";", spaces and tabs around it dropped, ASCII case aside.
    const semi = type.indexOf(";");
    let t = semi < 0 ? type : type.slice(0, semi);
    t = t.replace(/^[ \t]+|[ \t]+$/g, "").replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
    return t === "text/html";
}

/** Whether a reference names its scheme (spec/Frames.agda blobBase: only those resolve against a blob: base). */
export function hasScheme(ref: string): boolean {
    return /^[\x00-\x20]*[A-Za-z][A-Za-z0-9+.\-]*:/.test(ref);
}

/** A rewriter for a document whose base is a blob: URL: references without a scheme stay as written. */
function underBlobBase(rw: RewriteOne): RewriteOne {
    const keep = (u: string, f: () => string): string => (hasScheme(u) ? f() : u);
    const out: RewriteOne = Object.assign((u: string): string => keep(u, () => rw(u)), {
        // A <base href> with a scheme is a real base from there on; one
        // without is passed over (skipBase).
        withBase: (href: string): RewriteOne | null => (hasScheme(href) ? rw.withBase?.(href) ?? null : null),
        skipBase: true,
    });
    const wp = rw.withPolicy, wm = rw.withMark;
    if (wp) out.withPolicy = (u, p) => keep(u, () => wp(u, p));
    if (wm) out.withMark = (u, p, d) => keep(u, () => wm(u, p, d));
    return out;
}

function remake(win: Window, key: string, text: string, type: string): string | null {
    try {
        const B = (win as unknown as { Blob: typeof Blob }).Blob;
        const U = (win as unknown as { URL: typeof URL }).URL;
        const create = nO.getOwnPropertyDescriptor(U, "createObjectURL")?.value as ((b: Blob) => string) | undefined;
        if (!create) return null;
        const out = ncall(create, U, new B([text], { type })) as string;
        done.set(key, out);
        return out;
    } catch {
        return null;
    }
}

/** The URL a frame is given for a blob: URL: the rewritten document's, or null to give the URL as it is. */
export function blobDocumentFor(win: Window, url: string, rewriteOne: RewriteOne, proxyOrigin: string, bootstrap: (() => string) | undefined): string | null {
    if (!sStarts(url.toLowerCase(), "blob:")) return null;
    const hit = done.get("doc " + url);
    if (hit) return hit;
    const read = readBlob(win, url, "text/plain; charset=utf-8");
    if (!read || !htmlDocumentType(read.type)) return null;
    return remake(win, "doc " + url, rewriteSrcdoc(read.source, underBlobBase(rewriteOne), proxyOrigin, bootstrap), read.type);
}

/** The URL a stylesheet link is given for a blob: URL: the rewritten sheet's, or null to give the URL as it is. */
export function blobStylesheetFor(win: Window, url: string, rewriteOne: RewriteOne): string | null {
    if (!sStarts(url.toLowerCase(), "blob:")) return null;
    const hit = done.get("css " + url);
    if (hit) return hit;
    const read = readBlob(win, url, "text/plain; charset=utf-8");
    if (!read) return null;
    const css = rewriteCssText(read.source, rewriteOne);
    if (css === read.source) return null;
    return remake(win, "css " + url, css, read.type);
}

/** Whether a rel names a stylesheet (ASCII whitespace-separated, any case). */
export function relStylesheet(rel: string | null): boolean {
    if (rel === null) return false;
    for (const t of rel.split(/[\t\n\f\r ]+/)) if (t.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)) === "stylesheet") return true;
    return false;
}

/**
 * An element's attribute set to a blob: URL of content the page built: the
 * rewritten content's blob: URL, or null to set the value as given. `rel`:
 * a link's rel as it stands.
 */
export function blobValue(win: Window | null | undefined, tag: string, attr: string, rel: string | null, value: string,
    rewriteOne: RewriteOne, proxyOrigin: string, bootstrap: (() => string) | undefined): string | null {
    if (!win || !/^[\x00-\x20]*blob:/i.test(value)) return null;
    const t = tag.toLowerCase(), a = attr.toLowerCase(), url = value.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
    if (a === "src" && (t === "iframe" || t === "frame")) return blobDocumentFor(win, url, rewriteOne, proxyOrigin, bootstrap);
    if (a === "href" && t === "link" && relStylesheet(rel)) return blobStylesheetFor(win, url, rewriteOne);
    return null;
}

/** blobValue for an element of the document. */
export function elementBlobValue(el: Element, attr: string, value: string, rewriteOne: RewriteOne, proxyOrigin: string, bootstrap: (() => string) | undefined): string | null {
    if (el.namespaceURI !== "http://www.w3.org/1999/xhtml") return null;
    return blobValue(el.ownerDocument?.defaultView, el.localName, attr, el.localName === "link" ? el.getAttribute("rel") : null, value, rewriteOne, proxyOrigin, bootstrap);
}
