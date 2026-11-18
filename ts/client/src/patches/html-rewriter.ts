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
//   - Inline `<script>` bodies are passed through the JS source rewriter;
//     inline `<style>` / `style=""` is passed through the CSS rewriter —
//     same as the server-side rewriter does for static HTML.
//
// Recursion safety: this module is the implementation behind the patched
// `innerHTML` / `setAttribute` overloads, so it MUST avoid going through
// those overloads while doing its own work. We capture the *original*
// descriptors at module-init time (lazily, on first call) and bypass the
// patches by calling the originals directly.

import { trusted, trustedPolicyName } from "../native/trusted";
import { rewriteCssText } from "../css/rewriter";
import { ORIGINALS_ATTR } from "../native/originals";
import { defaultJsRewriteOptions, rewriteJsSource } from "../js/rewriter";
import { rewriteSrcsetAttribute } from "./srcset";
import { urlAttrsForTagName, isSrcsetAttr } from "./url-attribute-map";

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
 * An iframe's srcdoc as the frame must get it: its markup rewritten like
 * any other, and the runtime first — the frame's scripts run as it is
 * parsed, before anything could be injected from outside. The bootstrap
 * goes after a doctype, which must stay first (or the frame is in quirks
 * mode). The frame's base URL is its parent's, so the parent's rewriteOne
 * resolves its URLs.
 */
export function rewriteSrcdoc(
    html: string,
    rewriteOne: (url: string) => string,
    proxyOrigin: string = "",
    bootstrap?: () => string,
): string {
    const rewritten = rewriteHtmlString(html, rewriteOne, proxyOrigin, bootstrap);
    if (!bootstrap) return rewritten;
    const doctype = /^\s*<!doctype[^>]*>/i.exec(rewritten);
    const at = doctype ? doctype[0].length : 0;
    return rewritten.slice(0, at) + bootstrap() + rewritten.slice(at);
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
    proxyOrigin: string = "",
    bootstrap?: () => string,
): string {
    if (typeof html !== "string" || html.length === 0) return html;

    let natives: CapturedNatives;
    try {
        natives = ensureCaptured();
    } catch {
        // Environment doesn't expose Element.prototype.innerHTML — pass through.
        return html;
    }

    // A <template> drops the document's own tags (doctype, html, head,
    // body): kept aside here and put back as written after serialization.
    const structural: string[] = [];
    const parsed = holdStructuralTags(html, structural);

    const template = document.createElement("template");
    // (Trusted values for the sinks written below: under Trusted Types
    // the runtime's own policy makes them — native/trusted.ts.)
    const T = (kind: "HTML" | "Script" | "ScriptURL", text: string): string => trusted(globalThis, kind, text) as string;
    natives.innerHTMLSet.call(template, T("HTML", parsed));

    // The template content is a DocumentFragment; walk all element descendants.
    // querySelectorAll('*') matches all elements, in document order.
    const elements = template.content.querySelectorAll("*");
    // Each element's attributes as the page wrote them, to record what the
    // rewriting below changes (native/originals.ts).
    const written = new Map<Element, Map<string, string>>();
    for (const element of elements) {
        const m = new Map<string, string>();
        for (const a of Array.from(element.attributes)) m.set(a.name, a.value);
        written.set(element, m);
    }
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
                element.textContent = T("Script", rewriteJsSource(jsText, defaultJsRewriteOptions()));
            }
        }

        // 1c. <meta http-equiv="Content-Security-Policy"> — rewrite the CSP
        // content attribute to add the proxy origin to all *-src directives,
        // same as the server's rewriteCSP does for response headers. Without
        // this, ad scripts that document.write full HTML with an inline CSP
        // would block rewritten resource URLs (e.g. script-src only allowing
        // https://cdn.ampproject.org/ would block our proxied copies).
        if (
            proxyOrigin.length > 0 &&
            element.tagName === "META" &&
            /^content-security-policy$/i.test(element.getAttribute("http-equiv") ?? "")
        ) {
            const content = element.getAttribute("content") ?? "";
            if (content.length > 0) {
                natives.setAttribute.call(
                    element,
                    "content",
                    rewriteCspContent(content, proxyOrigin, trustedPolicyName()),
                );
            }
        }

        // 2. HTML_INTEGRITY — SRI hashes won't match rewritten content; drop.
        element.removeAttribute("integrity");

        // 3. HTML_CROSSORIGIN — normalize to use-credentials so cookies follow
        // the rewritten same-origin request, consistently across a resource and
        // its <link rel=preload>. A script preload left at "anonymous" mismatches
        // the forced use-credentials <script>, so the browser discards the
        // preload and double-fetches the bundle (wedging the coalesced HTTP/2
        // connection). Exception: a font preload stays anonymous to match the
        // non-credentialed @font-face fetch — forcing it double-fetches the font.
        if (element.hasAttribute("crossorigin")) {
            const rel = (element.getAttribute("rel") || "").toLowerCase();
            const as = (element.getAttribute("as") || "").toLowerCase();
            const isFontPreload =
                element.tagName === "LINK" &&
                (rel === "preload" || rel === "prefetch") &&
                as === "font";
            if (!isFontPreload) {
                natives.setAttribute.call(element, "crossorigin", "use-credentials");
            }
        }

        // 3b. <iframe srcdoc>: a whole document in an attribute.
        if (element.tagName === "IFRAME") {
            const srcdoc = element.getAttribute("srcdoc");
            if (srcdoc !== null) natives.setAttribute.call(element, "srcdoc", T("HTML", rewriteSrcdoc(srcdoc, rewriteOne, proxyOrigin, bootstrap)));
        }

        // 4. Global `style="..."` attribute — applies to every element.
        const styleAttr = element.getAttribute("style");
        if (styleAttr !== null && styleAttr.length > 0) {
            natives.setAttribute.call(
                element,
                "style",
                rewriteCssText(styleAttr, rewriteOne),
            );
        }

        // 5. Type-specific URL-bearing attributes (img.src, a.href, ...).
        const attrs = urlAttrsForTagName(element.tagName);
        if (!attrs) continue;
        for (const attrName of attrs) {
            const value = element.getAttribute(attrName);
            if (value === null || value.length === 0) continue;
            const rewritten = isSrcsetAttr(attrName)
                ? rewriteSrcsetAttribute(value, rewriteOne)
                : rewriteOne(value);
            // Use the captured native setAttribute so we don't recurse through
            // our own setAttribute patch (which would rewrite again).
            natives.setAttribute.call(element, attrName,
                attrName === "src" && (element.tagName === "SCRIPT" || element.tagName === "EMBED") ? T("ScriptURL", rewritten) : rewritten);
        }
    }

    // The originals attribute, as the server writes it: what changed.
    for (const [element, was] of written) {
        const o: Record<string, string | null> = {};
        let changed = false;
        const now = new Map<string, string>();
        for (const a of Array.from(element.attributes)) now.set(a.name, a.value);
        for (const [name, value] of was) if (now.get(name) !== value) { o[name] = value; changed = true; }
        for (const name of now.keys()) if (!was.has(name)) { o[name] = null; changed = true; }
        if (changed) natives.setAttribute.call(element, ORIGINALS_ATTR, JSON.stringify(o));
    }

    const out = natives.innerHTMLGet.call(template);
    return structural.length === 0 ? out : restoreStructuralTags(out, structural);
}

// ── The document's own tags ─────────────────────────────────────────────
//
// `<html><body><script>…document.body…</script></body></html>` written into
// an empty frame (DoubleVerify does exactly this) must reach the frame's
// parser with its <body>: without it the script runs in <head> and
// document.body is null. A template parses markup as a fragment and drops
// these tags, so each is replaced by a comment holding its index before
// parsing (a comment stays where it is) and written back afterwards.
// Script, style and other raw-text bodies and comments are skipped: a
// "<body>" inside them is text.

const HOLD = "\u007fcrn-tag-";
const RAW_TEXT = /^(script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)$/i;

function holdStructuralTags(html: string, held: string[]): string {
    let out = "";
    let i = 0;
    let from = 0;
    while ((i = html.indexOf("<", i)) !== -1) {
        if (html.startsWith("<!--", i)) {
            const end = html.indexOf("-->", i + 4);
            i = end === -1 ? html.length : end + 3;
            continue;
        }
        const m = /^<(\/?)([A-Za-z][^\s/>]*)|^<!doctype/i.exec(html.slice(i, i + 64));
        if (!m) { i++; continue; }
        const close = tagEnd(html, i);
        if (m[2] === undefined || /^(html|head|body)$/i.test(m[2])) {
            out += html.slice(from, i) + "<!--" + HOLD + held.length + "-->";
            held.push(html.slice(i, close));
            from = i = close;
            continue;
        }
        i = close;
        if (!m[1] && RAW_TEXT.test(m[2])) {
            const end = html.toLowerCase().indexOf("</" + m[2].toLowerCase(), i);
            i = end === -1 ? html.length : end;
        }
    }
    return held.length === 0 ? html : out + html.slice(from);
}

/** Where the tag starting at `at` ends: after its `>`, quotes respected. */
function tagEnd(html: string, at: number): number {
    let quote = "";
    for (let j = at + 1; j < html.length; j++) {
        const c = html[j]!;
        if (quote) { if (c === quote) quote = ""; continue; }
        if (c === '"' || c === "'") {
            // Quotes only open an attribute value (after "=").
            if (/=\s*$/.test(html.slice(Math.max(at, j - 8), j))) quote = c;
            continue;
        }
        if (c === ">") return j + 1;
    }
    return html.length;
}

function restoreStructuralTags(html: string, held: string[]): string {
    return html.replace(/<!--\u007fcrn-tag-(\d+)-->/g, (_, n: string) => held[Number(n)] ?? "");
}

// Mirrors Go's rewriteCSP: adds proxyOrigin to every *-src directive so
// proxy-rewritten resource URLs pass the browser's CSP check.
function rewriteCspContent(csp: string, proxyOrigin: string, ttPolicy?: string): string {
    const directives = csp.split(";");
    for (let i = 0; i < directives.length; i++) {
        const dir = directives[i]!;
        const parts = dir.trim().split(/\s+/);
        if (parts.length === 0 || !parts[0]) continue;
        const name = parts[0].toLowerCase();
        // As the server's rewriteCSP (go/src/internal/proxy/csp.go): reports
        // would go straight to the origin; and on an http proxy, upgrade-insecure-requests /
        // block-all-mixed-content would upgrade or block every proxied load.
        // Trusted Types stay enforced; the runtime's policy is admitted
        // beside the page's ('none' admits no policy: now only ours).
        if (name === "trusted-types") {
            const kept = parts.slice(1).filter((t) => t.toLowerCase() !== "'none'");
            if (ttPolicy && !kept.includes(ttPolicy) && !kept.includes("*")) kept.push(ttPolicy);
            const lead = dir.slice(0, dir.length - dir.trimStart().length);
            directives[i] = lead + parts[0] + " " + kept.join(" ");
            continue;
        }
        if (
            name === "report-uri" || name === "report-to" ||
            ((name === "upgrade-insecure-requests" || name === "block-all-mixed-content") &&
                proxyOrigin.toLowerCase().startsWith("http://"))
        ) {
            directives[i] = "";
            continue;
        }
        if (!name.includes("-src")) continue;

        // Check if proxy origin is already present. 'none' stays 'none' (as
        // Go's RewriteCSP): a source next to it would void it.
        let hasProxy = false;
        for (const tok of parts.slice(1)) {
            const t = tok.toLowerCase();
            if (t === proxyOrigin.toLowerCase() || t === "'none'") {
                hasProxy = true;
                break;
            }
        }
        if (!hasProxy) {
            // Preserve leading whitespace in the directive.
            const lead = dir.length - dir.trimStart().length;
            directives[i] = dir.slice(0, lead) + parts.join(" ") + " " + proxyOrigin;
        }
    }
    return directives.filter((d, i) => d !== "" || csp.split(";")[i] === "").join(";");
}
