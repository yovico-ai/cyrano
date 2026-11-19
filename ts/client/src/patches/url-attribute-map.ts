// Single source of truth for the URL-bearing attribute list.
//
// Three consumers:
//   - patches/url-attributes.ts   — patches the property setter on each
//                                   constructor's prototype
//   - patches/html-rewriter.ts    — looks up by uppercase tag name while
//                                   walking the parsed tree
//   - patches/dynamic-html.ts     — looks up by tag name from inside the
//                                   patched setAttribute method
//
// Keeping these in lockstep is what guarantees the "no difference between
// dynamic and static" property: an `<img src=...>` in the source HTML, an
// `el.src = ...` assignment, an `el.setAttribute('src', ...)`, an
// `el.innerHTML = '<img src=...>'` and a `document.write('<img src=...>')`
// all rewrite the same way.

// What an attribute's value is to cyrano: spec/Attrs.agda attrKind (Go:
// htmlrewrite/attrs.go). "url": fetched or navigated, proxified;
// "urllist": space-separated URLs (ping, attributionsrc), each proxified;
// "srcset"; "reflected": never fetched, but its IDL getter resolves it
// (q.cite, img.longDesc): kept, the getter unwrapped.
export type AttrKind = "url" | "urllist" | "srcset" | "reflected" | "none";

const htmlKinds: Record<string, Record<string, AttrKind>> = {};
const svgKinds: Record<string, Record<string, AttrKind>> = {};
const add = (m: Record<string, Record<string, AttrKind>>, k: AttrKind, attr: string, tags: string): void => {
    for (const t of tags.split(" ")) (m[t] ??= {})[attr] = k;
};
add(htmlKinds, "url", "src", "audio embed frame iframe img input script source track video");
add(htmlKinds, "url", "href", "a area base link");
add(htmlKinds, "url", "action", "form");
add(htmlKinds, "url", "formaction", "button input");
add(htmlKinds, "url", "data", "object");
add(htmlKinds, "url", "poster", "video");
add(htmlKinds, "url", "background", "body table tbody td tfoot th thead tr");
add(htmlKinds, "urllist", "ping", "a area");
add(htmlKinds, "urllist", "attributionsrc", "a area img script");
add(htmlKinds, "srcset", "srcset", "img source");
add(htmlKinds, "srcset", "imagesrcset", "link");
add(htmlKinds, "reflected", "cite", "blockquote del ins q");
add(htmlKinds, "reflected", "longdesc", "frame iframe img");
add(htmlKinds, "reflected", "lowsrc", "img");
add(htmlKinds, "reflected", "codebase", "object");
add(svgKinds, "url", "href", "a feimage image script use");
add(svgKinds, "url", "xlink:href", "a feimage image script use");

const own = (m: Record<string, Record<string, AttrKind>>, t: string): Record<string, AttrKind> | undefined =>
    Object.prototype.hasOwnProperty.call(m, t) ? m[t] : undefined;

/** spec attrKind: an attribute (lowercase) of an element (lowercase local name), SVG or HTML. */
export function urlAttrKind(svg: boolean, localName: string, attr: string): AttrKind {
    const row = svg ? own(svgKinds, localName) : own(htmlKinds, localName === "image" ? "img" : localName);
    return row && Object.prototype.hasOwnProperty.call(row, attr) ? row[attr]! : "none";
}

/** The element's attributes the runtimes rewrite (url, urllist, srcset). */
export function urlAttrsOf(el: Element): readonly string[] {
    const svg = el.namespaceURI === SVG_NS;
    const name = el.localName.toLowerCase();
    const row = svg ? own(svgKinds, name) : own(htmlKinds, name);
    if (!row) return [];
    return Object.keys(row).filter((a) => row[a] !== "reflected");
}

/** spec rewriteUrlList: each token between ASCII whitespace rewritten, the whitespace kept. */
export function rewriteUrlList(v: string, rw: (url: string) => string): string {
    return v.replace(/[^\t\n\f\r ]+/g, (tok) => rw(tok));
}

/** An attribute's value rewritten as its kind says. */
export function rewriteByKind(kind: AttrKind, v: string, rw: (url: string) => string, srcset: (v: string, rw: (url: string) => string) => string): string {
    switch (kind) {
        case "url": return rw(v);
        case "urllist": return rewriteUrlList(v, rw);
        case "srcset": return srcset(v, rw);
        default: return v;
    }
}

/** The kind of an element's attribute. */
export function kindOf(el: Element, attr: string): AttrKind {
    return urlAttrKind(el.namespaceURI === SVG_NS, el.localName.toLowerCase(), attr.toLowerCase());
}

// The IDL properties that reflect URL-bearing attributes, for the getter
// and setter patches (url-attributes.ts). "url": the getter resolves a URL
// (unwrapped); "text": it gives the attribute's text (the page's own);
// "reflected": getter only, the page's text resolved (unwrapped).
interface UrlBearingElement {
    tagName: string;       // matches `Element.tagName` (always uppercase)
    ctorName: string;      // matches the constructor's name on globalThis
    attrs: readonly string[]; // content attribute names (lowercase, matches getAttribute)
    // content attribute name → IDL property name when they differ
    idlNames?: Readonly<Record<string, string>>;
    // the getter's kind, when not "url" (srcset attributes are "text")
    getters?: Readonly<Record<string, "text" | "reflected">>;
}

export const URL_BEARING_ELEMENTS: ReadonlyArray<UrlBearingElement> = [
    { tagName: "IMG",    ctorName: "HTMLImageElement",  attrs: ["src", "srcset", "attributionsrc", "longdesc", "lowsrc"],
      idlNames: { attributionsrc: "attributionSrc", longdesc: "longDesc" }, getters: { attributionsrc: "text", longdesc: "reflected", lowsrc: "reflected" } },
    { tagName: "SCRIPT", ctorName: "HTMLScriptElement", attrs: ["src", "attributionsrc"], idlNames: { attributionsrc: "attributionSrc" }, getters: { attributionsrc: "text" } },
    { tagName: "IFRAME", ctorName: "HTMLIFrameElement", attrs: ["src", "longdesc"], idlNames: { longdesc: "longDesc" }, getters: { longdesc: "reflected" } },
    { tagName: "FRAME",  ctorName: "HTMLFrameElement",  attrs: ["src", "longdesc"], idlNames: { longdesc: "longDesc" }, getters: { longdesc: "reflected" } },
    { tagName: "SOURCE", ctorName: "HTMLSourceElement", attrs: ["src", "srcset"] },
    { tagName: "EMBED",  ctorName: "HTMLEmbedElement",  attrs: ["src"] },
    { tagName: "AUDIO",  ctorName: "HTMLAudioElement",  attrs: ["src"] },
    { tagName: "VIDEO",  ctorName: "HTMLVideoElement",  attrs: ["src", "poster"] },
    { tagName: "TRACK",  ctorName: "HTMLTrackElement",  attrs: ["src"] },
    { tagName: "BASE",   ctorName: "HTMLBaseElement",   attrs: ["href"] },
    { tagName: "LINK",   ctorName: "HTMLLinkElement",   attrs: ["href", "imagesrcset"], idlNames: { imagesrcset: "imageSrcset" } },
    { tagName: "A",      ctorName: "HTMLAnchorElement", attrs: ["href", "ping", "attributionsrc"], idlNames: { attributionsrc: "attributionSrc" }, getters: { ping: "text", attributionsrc: "text" } },
    { tagName: "AREA",   ctorName: "HTMLAreaElement",   attrs: ["href", "ping", "attributionsrc"], idlNames: { attributionsrc: "attributionSrc" }, getters: { ping: "text", attributionsrc: "text" } },
    { tagName: "FORM",   ctorName: "HTMLFormElement",   attrs: ["action"] },
    { tagName: "INPUT",  ctorName: "HTMLInputElement",  attrs: ["src", "formaction"], idlNames: { formaction: "formAction" } },
    { tagName: "BUTTON", ctorName: "HTMLButtonElement", attrs: ["formaction"],        idlNames: { formaction: "formAction" } },
    { tagName: "OBJECT", ctorName: "HTMLObjectElement", attrs: ["data", "codebase"], idlNames: { codebase: "codeBase" }, getters: { codebase: "reflected" } },
    { tagName: "BODY",   ctorName: "HTMLBodyElement",   attrs: ["background"], getters: { background: "text" } },
    { tagName: "Q",      ctorName: "HTMLQuoteElement",  attrs: ["cite"], getters: { cite: "reflected" } },
    { tagName: "DEL",    ctorName: "HTMLModElement",    attrs: ["cite"], getters: { cite: "reflected" } },
];

/** Returns the rewritten URL-bearing attributes of an HTML tag name (uppercase). */
export function urlAttrsForTagName(tagName: string): readonly string[] | undefined {
    const row = own(htmlKinds, tagName.toLowerCase());
    return row ? Object.keys(row).filter((a) => row[a] !== "reflected") : undefined;
}

/** Attributes whose value is a srcset (candidate URLs with descriptors), not one URL. */
export function isSrcsetAttr(name: string): boolean {
    return name === "srcset" || name === "imagesrcset";
}

export const SVG_NS = "http://www.w3.org/2000/svg";
export const XLINK_NS = "http://www.w3.org/1999/xlink";

/** The URL-bearing attributes of an SVG element (by its local name). */
export function svgUrlAttrs(localName: string): readonly string[] | undefined {
    const row = own(svgKinds, localName.toLowerCase());
    return row ? Object.keys(row) : undefined;
}
