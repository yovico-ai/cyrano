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

interface UrlBearingElement {
    tagName: string;       // matches `Element.tagName` (always uppercase)
    ctorName: string;      // matches the constructor's name on globalThis
    attrs: readonly string[]; // content attribute names (lowercase, matches getAttribute)
    // Maps content attribute name → IDL property name when they differ (e.g.
    // "formaction" → "formAction"). Only needed for prototype-setter patching;
    // absent entries default to the content attribute name verbatim.
    idlNames?: Readonly<Record<string, string>>;
}

export const URL_BEARING_ELEMENTS: ReadonlyArray<UrlBearingElement> = [
    { tagName: "IMG",    ctorName: "HTMLImageElement",  attrs: ["src", "srcset"] },
    { tagName: "SCRIPT", ctorName: "HTMLScriptElement", attrs: ["src"] },
    { tagName: "IFRAME", ctorName: "HTMLIFrameElement", attrs: ["src"] },
    { tagName: "SOURCE", ctorName: "HTMLSourceElement", attrs: ["src", "srcset"] },
    { tagName: "EMBED",  ctorName: "HTMLEmbedElement",  attrs: ["src"] },
    { tagName: "AUDIO",  ctorName: "HTMLAudioElement",  attrs: ["src"] },
    { tagName: "VIDEO",  ctorName: "HTMLVideoElement",  attrs: ["src", "poster"] },
    { tagName: "TRACK",  ctorName: "HTMLTrackElement",  attrs: ["src"] },
    { tagName: "BASE",   ctorName: "HTMLBaseElement",   attrs: ["href"] },
    { tagName: "LINK",   ctorName: "HTMLLinkElement",   attrs: ["href", "imagesrcset"], idlNames: { imagesrcset: "imageSrcset" } },
    { tagName: "A",      ctorName: "HTMLAnchorElement", attrs: ["href"] },
    { tagName: "AREA",   ctorName: "HTMLAreaElement",   attrs: ["href"] },
    { tagName: "FORM",   ctorName: "HTMLFormElement",   attrs: ["action"] },
    { tagName: "INPUT",  ctorName: "HTMLInputElement",  attrs: ["src", "formaction"], idlNames: { formaction: "formAction" } },
    { tagName: "BUTTON", ctorName: "HTMLButtonElement", attrs: ["formaction"],        idlNames: { formaction: "formAction" } },
    { tagName: "OBJECT", ctorName: "HTMLObjectElement", attrs: ["data"] },
];

const byTagName: Record<string, readonly string[]> = (() => {
    const map: Record<string, readonly string[]> = {};
    for (const entry of URL_BEARING_ELEMENTS) {
        map[entry.tagName] = entry.attrs;
    }
    return map;
})();

/** Returns the URL-bearing attribute list for a given tag name (uppercase). */
export function urlAttrsForTagName(tagName: string): readonly string[] | undefined {
    return byTagName[tagName];
}

/** Attributes whose value is a srcset (candidate URLs with descriptors), not one URL. */
export function isSrcsetAttr(name: string): boolean {
    return name === "srcset" || name === "imagesrcset";
}

export const SVG_NS = "http://www.w3.org/2000/svg";
export const XLINK_NS = "http://www.w3.org/1999/xlink";

/**
 * The URL-bearing attributes of an SVG element (by its lowercase local
 * name), as the server's table (go/src/internal/htmlrewrite/config.go):
 * an image, a use, a feImage, a link or a script refers by href or
 * xlink:href.
 */
export function svgUrlAttrs(localName: string): readonly string[] | undefined {
    switch (localName.toLowerCase()) {
        case "image": case "use": case "feimage": case "a": case "script":
            return ["href", "xlink:href"];
    }
    return undefined;
}
