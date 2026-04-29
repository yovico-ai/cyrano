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
    attrs: readonly string[]; // attribute names (lowercase, matches getAttribute lookup)
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
    { tagName: "LINK",   ctorName: "HTMLLinkElement",   attrs: ["href"] },
    { tagName: "A",      ctorName: "HTMLAnchorElement", attrs: ["href"] },
    { tagName: "AREA",   ctorName: "HTMLAreaElement",   attrs: ["href"] },
    { tagName: "FORM",   ctorName: "HTMLFormElement",   attrs: ["action"] },
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
