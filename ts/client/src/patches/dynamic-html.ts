// Prototype-level overloads for the *dynamic-HTML* surfaces — the channels
// through which page-side code injects URLs by writing strings of HTML or
// strings of attribute values, rather than via the typed property setters
// on individual element classes.
//
// Surfaces patched here:
//   - Element.prototype.innerHTML   (setter)
//   - Element.prototype.outerHTML   (setter)
//   - Element.prototype.insertAdjacentHTML  (method)
//   - Element.prototype.setAttribute        (method) — alternate path for the
//                                                     same attributes the
//                                                     property-setter patches
//                                                     in url-attributes.ts
//                                                     handle.
//
// Why these are critical:
//   The static-HTML rewriter on the server processes URL-bearing attributes
//   (img.src, a.href, etc.) before the page reaches the browser. But anything
//   the page constructs at runtime — `el.innerHTML = '<img src=…>'`,
//   `el.setAttribute('href', …)` — never goes through that pass. Without the
//   overloads here, dynamic content would leak the original URL straight
//   through to the browser without proxification.
//
// Recursion concerns:
//   Our overloads call into rewriteHtmlString (which sets template.innerHTML
//   internally) and onto the *original* setAttribute (to apply the rewritten
//   attributes to the parsed tree). Both code paths must bypass these very
//   patches. We solve that by:
//     1. Calling captureNativeElementOps() *before* installing patches, so
//        rewriteHtmlString grabs the originals.
//     2. Using the originals (saved in module-local vars) directly inside
//        our patched implementations.

import { rewriteCssText } from "../css/rewriter";
import { captureNativeElementOps, rewriteHtmlString } from "./html-rewriter";
import { rewriteSrcsetAttribute } from "./srcset";
import { urlAttrsForTagName } from "./url-attribute-map";

interface OriginalElementOps {
    innerHTMLDescriptor: PropertyDescriptor;
    outerHTMLDescriptor: PropertyDescriptor;
    insertAdjacentHTML: typeof Element.prototype.insertAdjacentHTML;
    setAttribute: typeof Element.prototype.setAttribute;
}

let savedOriginals: OriginalElementOps | null = null;

/**
 * Patches Element.prototype with the dynamic-HTML overloads. Idempotent —
 * if the prototype has already been patched (we keep a saved-originals
 * reference) we skip re-patching.
 */
export function patchDynamicHtml(
    _targetWindow: Window,
    rewriteOne: (url: string) => string,
    _unwrapOne: (url: string) => string,
): void {
    if (savedOriginals) return;

    // CRITICAL: snapshot the native descriptors for the html-rewriter *before*
    // we replace them. Otherwise rewriteHtmlString would try to use our own
    // patched setter and recurse.
    captureNativeElementOps();

    const innerHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    const outerHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, "outerHTML");
    if (!innerHTMLDesc?.set || !innerHTMLDesc?.get ||
        !outerHTMLDesc?.set || !outerHTMLDesc?.get) {
        // Browser doesn't expose the descriptors we need. Bail without patching.
        return;
    }

    savedOriginals = {
        innerHTMLDescriptor: innerHTMLDesc,
        outerHTMLDescriptor: outerHTMLDesc,
        insertAdjacentHTML: Element.prototype.insertAdjacentHTML,
        setAttribute: Element.prototype.setAttribute,
    };

    patchInnerHTML(rewriteOne, innerHTMLDesc);
    patchOuterHTML(rewriteOne, outerHTMLDesc);
    patchInsertAdjacentHTML(rewriteOne, savedOriginals.insertAdjacentHTML);
    patchSetAttribute(rewriteOne, savedOriginals.setAttribute);
    patchIntegrityProperty();
}

/** Test-only: undo the patches and reset the saved-originals flag. */
export function unpatchDynamicHtml(): void {
    if (!savedOriginals) return;
    Object.defineProperty(Element.prototype, "innerHTML", savedOriginals.innerHTMLDescriptor);
    Object.defineProperty(Element.prototype, "outerHTML", savedOriginals.outerHTMLDescriptor);
    Element.prototype.insertAdjacentHTML = savedOriginals.insertAdjacentHTML;
    Element.prototype.setAttribute = savedOriginals.setAttribute;
    savedOriginals = null;
}

function patchInnerHTML(
    rewriteOne: (url: string) => string,
    desc: PropertyDescriptor,
): void {
    const originalSet = desc.set!;
    const originalGet = desc.get!;
    Object.defineProperty(Element.prototype, "innerHTML", {
        configurable: true,
        enumerable: desc.enumerable ?? false,
        get(): unknown { return originalGet.call(this); },
        set(value: unknown): void {
            if (typeof value === "string") {
                originalSet.call(this, rewriteHtmlString(value, rewriteOne));
            } else {
                originalSet.call(this, value);
            }
        },
    });
}

function patchOuterHTML(
    rewriteOne: (url: string) => string,
    desc: PropertyDescriptor,
): void {
    const originalSet = desc.set!;
    const originalGet = desc.get!;
    Object.defineProperty(Element.prototype, "outerHTML", {
        configurable: true,
        enumerable: desc.enumerable ?? false,
        get(): unknown { return originalGet.call(this); },
        set(value: unknown): void {
            if (typeof value === "string") {
                originalSet.call(this, rewriteHtmlString(value, rewriteOne));
            } else {
                originalSet.call(this, value);
            }
        },
    });
}

function patchInsertAdjacentHTML(
    rewriteOne: (url: string) => string,
    originalInsertAdjacent: typeof Element.prototype.insertAdjacentHTML,
): void {
    Element.prototype.insertAdjacentHTML = function patchedInsertAdjacentHTML(
        this: Element,
        position: InsertPosition,
        text: string,
    ): void {
        const rewritten = typeof text === "string"
            ? rewriteHtmlString(text, rewriteOne)
            : text;
        return originalInsertAdjacent.call(this, position, rewritten);
    };
}

function patchSetAttribute(
    rewriteOne: (url: string) => string,
    originalSetAttribute: typeof Element.prototype.setAttribute,
): void {
    Element.prototype.setAttribute = function patchedSetAttribute(
        this: Element,
        name: string,
        value: string,
    ): void {
        if (typeof value !== "string") {
            return originalSetAttribute.call(this, name, value);
        }
        const lowerName = name.toLowerCase();

        // HTML_INTEGRITY — SRI hashes will never match rewritten content; drop
        // silently. Mirrors the server HTML rewriter's HTML_INTEGRITY rule.
        if (lowerName === "integrity") {
            return;
        }

        // HTML_CROSSORIGIN — force use-credentials so cookies follow through,
        // consistently with the resource's <link rel=preload> (a script preload
        // left at "anonymous" mismatches the forced use-credentials <script> and
        // gets discarded → double-fetch). Exception: a font preload keeps its
        // original (anonymous) mode to match the non-credentialed @font-face
        // fetch. Mirrors the server HTML rewriter's HTML_CROSSORIGIN rule. (rel/as
        // are read best-effort — if set after crossorigin, the default applies.)
        if (lowerName === "crossorigin") {
            const el = this as Element;
            const rel = (el.getAttribute("rel") || "").toLowerCase();
            const as = (el.getAttribute("as") || "").toLowerCase();
            const isFontPreload =
                el.tagName === "LINK" &&
                (rel === "preload" || rel === "prefetch") &&
                as === "font";
            if (isFontPreload) {
                return originalSetAttribute.call(this, name, value);
            }
            return originalSetAttribute.call(this, name, "use-credentials");
        }

        // The `style` attribute applies to every element and contains CSS
        // declarations. Rewrite the CSS rather than the URL — matches the
        // server's HTML rewriter, which dispatches inline styles to the CSS
        // rewriter regardless of the host element's type.
        if (lowerName === "style") {
            return originalSetAttribute.call(
                this,
                name,
                rewriteCssText(value, rewriteOne),
            );
        }

        // Type-specific URL-bearing attributes (img.src, a.href, ...).
        const attrs = urlAttrsForTagName(this.tagName);
        if (!attrs || !attrs.includes(lowerName)) {
            return originalSetAttribute.call(this, name, value);
        }
        const rewritten = lowerName === "srcset"
            ? rewriteSrcsetAttribute(value, rewriteOne)
            : rewriteOne(value);
        return originalSetAttribute.call(this, name, rewritten);
    };
}

// Patch the .integrity property setter on <script> and <link> elements.
// When JS assigns `el.integrity = '...'` directly (not via setAttribute),
// we noop the setter and return "" from the getter — same effect as the
// server-side HTML_INTEGRITY rule stripping the attribute.
function patchIntegrityProperty(): void {
    for (const ctorKey of ["HTMLScriptElement", "HTMLLinkElement"] as const) {
        const ctor = (globalThis as Record<string, unknown>)[ctorKey] as
            | { prototype: Record<string, unknown> }
            | undefined;
        if (!ctor?.prototype) continue;
        try {
            Object.defineProperty(ctor.prototype, "integrity", {
                configurable: true,
                enumerable: false,
                get() { return ""; },
                set(_v: string) { /* drop — SRI hash won't match rewritten content */ },
            });
        } catch {
            // Non-configurable in this environment — skip gracefully.
        }
    }
}
