// The URL-bearing IDL attributes of HTML elements (img.src, a.href,
// form.action, …) and the URL parts anchors and areas reflect (a.host,
// a.pathname, …), as page code sees them natively.
//
// Setting proxifies the value before it lands on the element (srcset: each
// candidate's URL, the rest byte for byte — spec/Srcset.agda). Getting
// returns the original URL: the element holds the proxified one, which is
// unwrapped (srcset: each candidate's). Every accessor keeps its native
// descriptor (native/surface.ts).
//
// Known gap: natively these getters return the URL resolved against the
// page; unwrapping gives exactly that for URLs the element resolved itself.
// getAttribute and srcset return the text as the page *wrote* it (relative
// URLs relative) — that needs the original text kept, a separate step.

import { rewriteCssText } from "../css/rewriter";
import { nO, nR, ncall } from "../native/intrinsics";
import { isTrustedValue, trusted } from "../native/trusted";
import { rewriteSrcsetAttribute } from "./srcset";
import { URL_BEARING_ELEMENTS, isSrcsetAttr } from "./url-attribute-map";
import { wrapConstructor, wrapAccessor } from "../native/surface";
import { originalAttr, recordAttr } from "../native/originals";

type ProtoLike = { prototype: object };

export function patchUrlAttributes(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
    unwrapOne: (url: string) => string = (u) => u,
): void {
    const globals = targetWindow as unknown as Record<string, ProtoLike | undefined>;
    for (const { ctorName, attrs, idlNames } of URL_BEARING_ELEMENTS) {
        const proto = globals[ctorName]?.prototype;
        if (!proto) continue;
        for (const attribute of attrs) {
            const srcset = isSrcsetAttr(attribute);
            wrapAccessor<unknown>(proto, idlNames?.[attribute] ?? attribute, {
                get: (get, self) => {
                    const v = ncall(get, self);
                    if (typeof v !== "string") return v;
                    // srcset reflects the attribute's text: the page's own.
                    // The others are resolved URLs: the original's.
                    if (srcset) return originalAttr(self, attribute)?.value ?? rewriteSrcsetAttribute(v, unwrapOne);
                    return unwrapOne(v);
                },
                set: (set, self, value) => {
                    // null/undefined keep their native meaning; Trusted Types
                    // objects stringify to their URL.
                    if (value == null) return ncall(set, self, value);
                    const s = String(value);
                    const now = srcset ? rewriteSrcsetAttribute(s, rewriteOne) : rewriteOne(s);
                    // A TrustedScriptURL (script.src under Trusted Types) stays trusted.
                    ncall(set, self, isTrustedValue(value) ? trusted(targetWindow, "ScriptURL", now) : now);
                    recordAttr(self as Element, attribute, now, s);
                },
            });
        }
    }
}

/**
 * new Audio(url): the element is made with its src set by the browser
 * itself, past the src setter. The URL is proxified, and the page reads
 * back the one it gave (originals).
 */
export function patchAudioConstructor(targetWindow: Window, rewriteOne: (url: string) => string): void {
    wrapConstructor<typeof Audio>(targetWindow, "Audio", (Native, args, newTarget) => {
        if (!args.length || args[0] === undefined) return nR.construct(Native, args, newTarget as typeof Audio);
        const given = String(args[0]);
        const now = rewriteOne(given);
        const el = nR.construct(Native, [now, ...args.slice(1)], newTarget as typeof Audio) as HTMLAudioElement;
        if (now !== given) recordAttr(el, "src", now, given);
        return el;
    });
}

/**
 * new FontFace(family, source): a string source is a CSS src value —
 * url(…) format(…), local(…) — whose URLs the browser fetches itself
 * (IMDb's fonts escaped the proxy). Its url()s are proxified; a buffer
 * source is left alone. A FontFace does not show its source to script.
 */
export function patchFontFaceConstructor(targetWindow: Window, rewriteOne: (url: string) => string): void {
    wrapConstructor<typeof FontFace>(targetWindow, "FontFace", (Native, args, newTarget) => {
        const next = args.slice();
        if (typeof next[1] === "string") next[1] = rewriteCssText(next[1], rewriteOne);
        return nR.construct(Native, next, newTarget as typeof FontFace);
    });
}

// The URL parts anchors and areas reflect from their href.
const PARTS_RW = ["protocol", "host", "hostname", "port", "pathname", "search", "hash", "username", "password"] as const;
const PARTS_RO = ["origin"] as const;

/**
 * a.host, a.pathname, … read and write the parts of the original URL.
 * Must run before patchUrlAttributes, so that it reaches the native href.
 */
export function patchAnchorUrlReflection(
    targetWindow: Window,
    unwrapOne: (url: string) => string,
    rewriteOne: (url: string) => string,
): void {
    const globals = targetWindow as unknown as Record<string, ProtoLike | undefined>;
    for (const ctorName of ["HTMLAnchorElement", "HTMLAreaElement"]) {
        const proto = globals[ctorName]?.prototype;
        if (!proto) continue;
        const hrefDesc = findDescriptor(proto, "href");
        if (!hrefDesc?.get || !hrefDesc.set) continue;
        const hrefGet = hrefDesc.get;
        const hrefSet = hrefDesc.set;
        // The original URL behind this element's href, or null when its href
        // is not a proxified URL (then the native part is the right answer).
        const original = (self: unknown): URL | null => {
            const raw = ncall(hrefGet, self) as string;
            if (!raw) return null;
            const o = unwrapOne(raw);
            if (o === raw) return null;
            try { return new URL(o); } catch { return null; }
        };
        for (const part of [...PARTS_RW, ...PARTS_RO]) {
            const readOnly = (PARTS_RO as readonly string[]).includes(part);
            wrapAccessor<string>(proto, part, {
                get: (get, self) => {
                    const u = original(self);
                    return u ? (u[part] as string) : ncall(get, self);
                },
                ...(readOnly ? {} : {
                    set: (set: (this: unknown, v: string) => void, self: unknown, value: string) => {
                        const u = original(self);
                        if (!u) return ncall(set, self, value);
                        (u as unknown as Record<string, unknown>)[part] = value;
                        ncall(hrefSet, self, rewriteOne(u.href));
                    },
                }),
            });
        }
    }
}

function findDescriptor(o: object, key: string): PropertyDescriptor | undefined {
    for (let p: object | null = o; p; p = nO.getPrototypeOf(p) as object | null) {
        const d = nO.getOwnPropertyDescriptor(p, key);
        if (d) return d;
    }
    return undefined;
}
