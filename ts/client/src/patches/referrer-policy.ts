// An element's referrer policy, as page code sees it natively, and as the
// upstream receives it.
//
// The browser applies an element's referrerpolicy (or fetch's
// referrerPolicy) to proxy URLs: "origin" gives "http://proxy/", which names
// neither the page nor its origin, and the upstream got no Referer
// (BlockThrough's frame answered 400). So the policy travels in the
// proxified URL instead — /cyrano/https!origin/… (spec/Containment.agda
// rewriteUrlWith) — the browser is told unsafe-url, and the proxy applies
// the policy to the full page URL it now receives (Go: proxy/fetch_headers.go;
// the server marks its markup the same way: htmlrewrite elementReferrerPolicy).
//
// The page reads back what it wrote: the attribute (read-back originals),
// the referrerPolicy property (the keyword, or "" when invalid), and its URLs
// unmarked.

import { documentQueryEncoder, requery } from "../url/doc-query";
import { SafeSet, nO, ncall } from "../native/intrinsics";
import { heldAttr, holdAttr, originalAttr, recordAttr } from "../native/originals";
import { wrapAccessor, wrapMethod } from "../native/surface";
import { isReferrerPolicy } from "../url/containment";
import { rewriteSrcsetAttribute } from "./srcset";
import { kindOf, rewriteByKind, urlAttrsOf, urlDestOf } from "./url-attribute-map";
import type { Dest } from "../url/containment";

/** A rewriter of URLs that can also mark the request's referrer policy. */
export interface RewriteOne {
    (url: string): string;
    withPolicy?: (url: string, policy: string) => string;
    /** Marked: a referrer policy of its own, what it is requested for (spec/Containment.agda Mark). */
    withMark?: (url: string, policy: string | null, dest: Dest | null) => string;
    /**
     * The same, resolving against a document base set by `<base href>`
     * (spec/Html.agda documentBase: parsed against the current base); null
     * when the href does not parse.
     */
    withBase?: (href: string) => RewriteOne | null;
    /** A <base href> withBase cannot resolve is passed over, not the end of the search (a blob document's). */
    skipBase?: boolean;
    /**
     * The same, resolving against the document's own URL (its fallback base):
     * a `<base href>` is resolved against that, never the base before it.
     */
    atDocumentUrl?: RewriteOne;
    /** The base it resolves against, as the page has it (a module's import.meta.url and specifiers). */
    baseHref?: () => string;
}

const HTML_NS = "http://www.w3.org/1999/xhtml";
const TAGS = new SafeSet(["A", "AREA", "IMG", "IFRAME", "LINK", "SCRIPT"]);
const CTORS = ["HTMLAnchorElement", "HTMLAreaElement", "HTMLImageElement", "HTMLIFrameElement", "HTMLLinkElement", "HTMLScriptElement"];

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** The referrer policy an element's referrerpolicy states (as the page wrote it), or null. */
export function elementPolicy(el: Element): string | null {
    try {
        if (el.namespaceURI !== HTML_NS || !TAGS.has(el.tagName)) return null;
        const o = originalAttr(el, "referrerpolicy");
        const v = o ? o.value : heldAttr(el, "referrerpolicy");
        if (v === null) return null;
        const t = asciiLower(v);
        return isReferrerPolicy(t) ? t : null;
    } catch {
        return null;
    }
}

/**
 * rewriteOne, for a URL in this element's attribute: marked with its
 * referrer policy, if it states one, and with what it is requested for — a
 * script or a stylesheet (spec/Attrs.agda urlDest).
 */
export function rewriteFor(el: Element, rewriteOne0: RewriteOne, attr?: string): (url: string) => string {
    const plain = rewriteFor0(el, rewriteOne0, attr);
    // In a legacy-encoded document the query is the document's encoding's
    // (spec/Encoding.agda; not for CSS, which is UTF-8).
    let enc: ((q: string) => string) | null = null;
    try {
        const win = el.ownerDocument?.defaultView;
        enc = win ? documentQueryEncoder(win) : null;
    } catch { enc = null; }
    if (!enc || attr === "style") return plain;
    const e = enc;
    return (u) => requery(plain(u), u, e);
}

function rewriteFor0(el: Element, rewriteOne0: RewriteOne, attr?: string): (url: string) => string {
    // A <base href>: against the document's URL (spec/Html.agda documentBase),
    // not the base it replaces (multistate.us: a base set again and again
    // stepped up a directory each time).
    let rewriteOne = rewriteOne0;
    try {
        if (attr === "href" && rewriteOne0.atDocumentUrl && el.localName === "base" && el.namespaceURI === "http://www.w3.org/1999/xhtml") rewriteOne = rewriteOne0.atDocumentUrl;
    } catch { /* as it is */ }
    const p = elementPolicy(el);
    const d = attr === undefined ? null : urlDestOf(el, attr);
    const withMark = rewriteOne.withMark;
    if ((p || d) && withMark) return (u) => withMark(u, p, d);
    const withPolicy = rewriteOne.withPolicy;
    return p && withPolicy ? (u) => withPolicy(u, p) : rewriteOne;
}

/** The element's URL attributes rewritten again from what the page wrote (its policy changed). */
export function remark(el: Element, rewriteOne: RewriteOne): void {
    const attrs = urlAttrsOf(el);
    for (const name of attrs) {
        const rw = rewriteFor(el, rewriteOne, name);
        const o = originalAttr(el, name);
        const was = o ? o.value : heldAttr(el, name);
        if (was === null || was === "") continue;
        const now = rewriteByKind(kindOf(el, name), was, rw, rewriteSrcsetAttribute);
        holdAttr(el, name, now);
        recordAttr(el, name, now, was);
    }
}

/**
 * The referrerPolicy property (reflecting the attribute: the keyword, or ""),
 * and removing the attribute. Setting the attribute goes through the
 * setAttribute wrapper (dynamic-html.ts), which tells the browser
 * unsafe-url and re-marks the element's URLs.
 */
export function patchReferrerPolicy(targetWindow: Window, rewriteOne: RewriteOne): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    const E = g["Element"]?.prototype as Element | undefined;
    if (!E) return;
    const setAttr = nO.getOwnPropertyDescriptor(E, "setAttribute")?.value as ((this: Element, n: string, v: string) => void) | undefined;
    for (const name of CTORS) {
        const proto = g[name]?.prototype;
        if (!proto || !nO.getOwnPropertyDescriptor(proto, "referrerPolicy")) continue;
        wrapAccessor<unknown>(proto, "referrerPolicy", {
            get: (_get, self) => elementPolicy(self as Element) ?? "",
            set: (set, self, v) => {
                if (setAttr) ncall(setAttr, self, "referrerpolicy", String(v));
                else ncall(set, self, v);
            },
        });
    }
    wrapMethod<(...a: unknown[]) => void>(E, "removeAttribute", (native, self, args) => {
        const had = typeof self === "object" && self !== null && elementPolicy(self as Element) !== null;
        ncall(native, self, ...args);
        if (had && typeof args[0] === "string" && asciiLower(args[0]) === "referrerpolicy") remark(self as Element, rewriteOne);
    });
}
