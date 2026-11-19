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

import { SafeSet, nO, ncall } from "../native/intrinsics";
import { heldAttr, holdAttr, originalAttr, recordAttr } from "../native/originals";
import { wrapAccessor, wrapMethod } from "../native/surface";
import { isReferrerPolicy } from "../url/containment";
import { rewriteSrcsetAttribute } from "./srcset";
import { isSrcsetAttr, urlAttrsForTagName } from "./url-attribute-map";

/** A rewriter of URLs that can also mark the request's referrer policy. */
export interface RewriteOne {
    (url: string): string;
    withPolicy?: (url: string, policy: string) => string;
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

/** rewriteOne, for a URL of this element: marked with its referrer policy, if it states one. */
export function rewriteFor(el: Element, rewriteOne: RewriteOne): (url: string) => string {
    const p = elementPolicy(el);
    const withPolicy = rewriteOne.withPolicy;
    return p && withPolicy ? (u) => withPolicy(u, p) : rewriteOne;
}

/** The element's URL attributes rewritten again from what the page wrote (its policy changed). */
export function remark(el: Element, rewriteOne: RewriteOne): void {
    const attrs = urlAttrsForTagName(el.tagName);
    if (!attrs) return;
    const rw = rewriteFor(el, rewriteOne);
    for (const name of attrs) {
        const o = originalAttr(el, name);
        const was = o ? o.value : heldAttr(el, name);
        if (was === null || was === "") continue;
        const now = isSrcsetAttr(name) ? rewriteSrcsetAttribute(was, rw) : rw(was);
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
