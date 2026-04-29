// Client-side HTML mini-rewriter.
//
// Used by the prototype overloads for `innerHTML` / `outerHTML` /
// `insertAdjacentHTML` and by the `document.write` wrapper to rewrite
// URL-bearing attributes in arbitrary HTML payloads before they reach the
// document parser.
//
// Strategy: leverage the browser's own HTML parser via an HTMLTemplateElement.
// Setting `template.innerHTML = html` parses the input into a DocumentFragment
// without running any scripts (template content is inert per spec). We walk
// the resulting tree, rewrite every URL-bearing attribute we recognise, and
// serialize back with `template.innerHTML`.
//
// Why this approach:
//   - Mirrors the server's HTML rewriter at the same level of granularity
//     (token-level attribute rewriting). The browser's parser is closer to
//     spec-compliant than anything we could ship in the bundle.
//   - Zero parser dependency.
//   - Inline `<script>` and `<style>` content is NOT yet rewritten — that
//     requires the JS / CSS source rewriters on the client and is tracked
//     separately. Their rewriting is no-op here, so a `document.write` that
//     embeds inline scripts with URL string literals is still a leak surface
//     until the JS rewriter lands.
//
// Recursion safety: this module is the implementation behind the patched
// `innerHTML` / `setAttribute` overloads, so it MUST avoid going through
// those overloads while doing its own work. We capture the *original*
// descriptors at module-init time (lazily, on first call) and bypass the
// patches by calling the originals directly.

import { rewriteCssText } from "../css/rewriter";
import { defaultJsRewriteOptions, rewriteJsSource } from "../js/rewriter";
import { rewriteSrcsetAttribute } from "./srcset";
import { urlAttrsForTagName } from "./url-attribute-map";

interface CapturedNatives {
    innerHTMLGet: (this: Element) => string;
    innerHTMLSet: (this: Element, value: string) => void;
    setAttribute: (this: Element, name: string, value: string) => void;
}

// Captured exactly once on first use, before any of our overloads have a
// chance to be installed (or, if installed, we still get the original by
// capturing from the spec-defined Element.prototype descriptor we cached).
let captured: CapturedNatives | null = null;

/**
 * Public hook: lets the patches/install module hand us the *original*
 * descriptors *before* it patches Element.prototype. Calling this is
 * optional — if not called, we'll lazily capture descriptors at first use,
 * which is safe as long as nobody has already monkey-patched the prototype
 * before our installer runs.
 */
export function captureNativeElementOps(): void {
    if (captured) return;
    captured = readCurrentDescriptors();
}

function readCurrentDescriptors(): CapturedNatives {
    const innerHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    if (!innerHTMLDesc?.set || !innerHTMLDesc?.get) {
        throw new Error("Element.prototype.innerHTML descriptor missing — environment unsupported");
    }
    return {
        innerHTMLGet: innerHTMLDesc.get as CapturedNatives["innerHTMLGet"],
        innerHTMLSet: innerHTMLDesc.set as CapturedNatives["innerHTMLSet"],
        setAttribute: Element.prototype.setAttribute as CapturedNatives["setAttribute"],
    };
}

function ensureCaptured(): CapturedNatives {
    if (!captured) captured = readCurrentDescriptors();
    return captured;
}

/**
 * Rewrites every URL-bearing attribute in the given HTML string and returns
 * the rewritten serialization. Returns the input unchanged when:
 *   - input is empty / not a string,
 *   - we can't capture native descriptors (missing `Element.prototype`),
 *   - parsing fails (which shouldn't happen — the browser tolerates broken
 *     HTML by inserting recovery nodes, and the result still serializes).
 */
export function rewriteHtmlString(
    html: string,
    rewriteOne: (url: string) => string,
): string {
    if (typeof html !== "string" || html.length === 0) return html;

    let natives: CapturedNatives;
    try {
        natives = ensureCaptured();
    } catch {
        // Environment doesn't expose Element.prototype.innerHTML — pass through.
        return html;
    }

    const template = document.createElement("template");
    natives.innerHTMLSet.call(template, html);

    // The template content is a DocumentFragment; walk all element descendants.
    // querySelectorAll('*') matches all elements, in document order.
    const elements = template.content.querySelectorAll("*");
    for (const element of elements) {
        // 1a. Inline <style> content — rewrite as a CSS source string.
        if (element.tagName === "STYLE") {
            const cssText = element.textContent ?? "";
            if (cssText.length > 0) {
                element.textContent = rewriteCssText(cssText, rewriteOne);
            }
        }

        // 1b. Inline <script> content (no `src` attribute — body is the
        // source). Run it through the JS source rewriter so `wrap_*` calls
        // are injected the same way the server-side rewriter would have
        // done it for a static <script>.
        if (element.tagName === "SCRIPT" && !element.hasAttribute("src")) {
            const jsText = element.textContent ?? "";
            if (jsText.length > 0) {
                element.textContent = rewriteJsSource(jsText, defaultJsRewriteOptions());
            }
        }

        // 2. Global `style="..."` attribute — applies to every element.
        const styleAttr = element.getAttribute("style");
        if (styleAttr !== null && styleAttr.length > 0) {
            natives.setAttribute.call(
                element,
                "style",
                rewriteCssText(styleAttr, rewriteOne),
            );
        }

        // 3. Type-specific URL-bearing attributes (img.src, a.href, ...).
        const attrs = urlAttrsForTagName(element.tagName);
        if (!attrs) continue;
        for (const attrName of attrs) {
            const value = element.getAttribute(attrName);
            if (value === null || value.length === 0) continue;
            const rewritten = attrName === "srcset"
                ? rewriteSrcsetAttribute(value, rewriteOne)
                : rewriteOne(value);
            // Use the captured native setAttribute so we don't recurse through
            // our own setAttribute patch (which would rewrite again).
            natives.setAttribute.call(element, attrName, rewritten);
        }
    }

    return natives.innerHTMLGet.call(template);
}
