// An SVG element's `href` (SVGURIReference: <image>, <use>, <a>, <script>,
// <feImage>, gradients, patterns, filters, <textPath>, <mpath>) is an
// SVGAnimatedString: setting its `baseVal` writes the attribute, which
// loaded from its origin — the setAttribute / setAttributeNS rewriting
// never saw it — and `baseVal` / `animVal` read the proxified URL.
//
// Chromium's reflection, measured (svg-href-vs-chromium): a read gives
// `href` when the element has it, else `xlink:href`, else ""; a write sets
// `href`, unless only `xlink:href` is there. So a write goes through the
// runtime's own setAttribute / setAttributeNS (rewritten by the attribute
// table, originals and history kept, as any write of the attribute), and
// a read through its read-back getAttribute / getAttributeNS. The
// SVGAnimatedString is tied to its element when `href` hands it out (the
// one way to reach it; other SVGAnimatedStrings — className — are left
// alone). animVal while an animation runs: the native's value, unwrapped.

import { SafeWeakMap, nO, ncall } from "../native/intrinsics";
import { wrapAccessor } from "../native/surface";

const XLINK = "http://www.w3.org/1999/xlink";

export function patchSvgHref(targetWindow: Window, unwrapOne: (url: string) => string): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    const SAS = g["SVGAnimatedString"]?.prototype;
    const E = g["Element"]?.prototype as Record<string, unknown> | undefined;
    if (!SAS || !E) return;
    // The runtime's own (installed before this): rewriting and read-back.
    const setAttr = E["setAttribute"] as (this: Element, n: string, v: string) => void;
    const setAttrNS = E["setAttributeNS"] as (this: Element, ns: string, n: string, v: string) => void;
    const getAttr = E["getAttribute"] as (this: Element, n: string) => string | null;
    const getAttrNS = E["getAttributeNS"] as (this: Element, ns: string, n: string) => string | null;
    const hasAttr = nO.getOwnPropertyDescriptor(E, "hasAttribute")?.value as (this: Element, n: string) => boolean;
    const hasAttrNS = nO.getOwnPropertyDescriptor(E, "hasAttributeNS")?.value as (this: Element, ns: string, n: string) => boolean;
    if (!setAttr || !setAttrNS || !getAttr || !getAttrNS || !hasAttr || !hasAttrNS) return;

    const owner = new SafeWeakMap<object, Element>();
    for (const name of nO.getOwnPropertyNames(targetWindow)) {
        if (name.length < 4 || name[0] !== "S" || name[1] !== "V" || name[2] !== "G") continue;
        const proto = g[name]?.prototype;
        const d = proto ? nO.getOwnPropertyDescriptor(proto, "href") : undefined;
        if (!proto || !d?.get || d.set) continue; // a read-only SVGAnimatedString accessor
        wrapAccessor<unknown>(proto, "href", {
            get: (get, self) => {
                const v = ncall(get, self);
                if (typeof v === "object" && v !== null) owner.set(v, self as Element);
                return v;
            },
        });
    }
    const nativeBase = nO.getOwnPropertyDescriptor(SAS, "baseVal")?.get as ((this: unknown) => unknown) | undefined;
    /** What the element's href reads as the page wrote it. */
    const pageValue = (el: Element): string =>
        ncall(hasAttr, el, "href") ? ncall(getAttr, el, "href") ?? "" : ncall(getAttrNS, el, XLINK, "href") ?? "";
    wrapAccessor<unknown>(SAS, "baseVal", {
        get: (get, self) => {
            const el = owner.get(self as object);
            return el ? pageValue(el) : ncall(get, self);
        },
        set: (set, self, v) => {
            const el = owner.get(self as object);
            if (!el) return ncall(set, self, v);
            const text = String(v); // converted once, as natively
            if (!ncall(hasAttr, el, "href") && ncall(hasAttrNS, el, XLINK, "href")) {
                // the attribute as it is named on the element (its own prefix)
                const attr = nO.getOwnPropertyDescriptor(g["Element"]!.prototype, "attributes")?.get;
                let qname = "xlink:href";
                try {
                    const list = attr ? ncall(attr, el) as NamedNodeMap : el.attributes;
                    const a = list.getNamedItemNS(XLINK, "href");
                    if (a) qname = a.name;
                } catch { /* the usual prefix */ }
                ncall(setAttrNS, el, XLINK, qname, text);
            } else {
                ncall(setAttr, el, "href", text);
            }
        },
    });
    wrapAccessor<unknown>(SAS, "animVal", {
        get: (get, self) => {
            const el = owner.get(self as object);
            const v = ncall(get, self);
            if (!el || typeof v !== "string") return v;
            // Not animated, it is baseVal (as written); animated, the
            // animation's value, unwrapped.
            return nativeBase && v === ncall(nativeBase, self) ? pageValue(el) : unwrapOne(v);
        },
    });
}
