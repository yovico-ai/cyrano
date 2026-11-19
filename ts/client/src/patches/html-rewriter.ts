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

import { rewriteFor, type RewriteOne } from "./referrer-policy";
import { scriptKindOf } from "./script-kind";
import { rewriteImportMap } from "./dynamic-html";
import { SafeMap, SafeSet, nO, ncall } from "../native/intrinsics";
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
    const innerHTMLDesc = nO.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
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
    const parsed = hideStyleAttributes(holdStructuralTags(html, structural));

    // Style attributes are parsed under another name: parsing one, anywhere,
    // is checked against the page's CSP (a nonce policy refuses it) and
    // reported as a violation — the page's own insertion of the result is
    // the one parse the page causes natively (reCAPTCHA's innerHTML on
    // my.jumpapp.com reported twice).
    const template = document.createElement("template");
    // (Trusted values for the sinks written below: under Trusted Types
    // the runtime's own policy makes them — native/trusted.ts.)
    const T = (kind: "HTML" | "Script" | "ScriptURL", text: string): string => trusted(globalThis, kind, text) as string;
    ncall(natives.innerHTMLSet, template, T("HTML", parsed));

    // The template content is a DocumentFragment; walk all element descendants.
    // querySelectorAll('*') matches all elements, in document order.
    const elements = template.content.querySelectorAll("*");
    // Each element's attributes as the page wrote them, to record what the
    // rewriting below changes (native/originals.ts).
    const written = new SafeMap<Element, Map<string, string>>();
    for (const element of elements) {
        const m = new SafeMap<string, string>();
        for (const a of Array.from(element.attributes)) m.set(a.name === HIDDEN_STYLE ? "style" : a.name, a.value);
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
        // What it is decides (spec/Html.agda scriptKind): JavaScript is
        // rewritten as such, an import map as one, a data block not at all.
        if (element.tagName === "SCRIPT" && !element.hasAttribute("src")) {
            const jsText = element.textContent ?? "";
            const kind = scriptKindOf(element);
            if (jsText.length > 0 && (kind === "classic" || kind === "module")) {
                element.textContent = T("Script", rewriteJsSource(jsText, defaultJsRewriteOptions()));
            } else if (jsText.length > 0 && kind === "importmap") {
                element.textContent = rewriteImportMap(jsText, rewriteOne);
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
                ncall(natives.setAttribute, element, "content", rewriteCspContent(content, proxyOrigin, trustedPolicyName()));
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
                ncall(natives.setAttribute, element, "crossorigin", "use-credentials");
            }
        }

        // 3b. <iframe srcdoc>: a whole document in an attribute.
        if (element.tagName === "IFRAME") {
            const srcdoc = element.getAttribute("srcdoc");
            if (srcdoc !== null) ncall(natives.setAttribute, element, "srcdoc", T("HTML", rewriteSrcdoc(srcdoc, rewriteOne, proxyOrigin, bootstrap)));
        }

        // 4. Global `style="..."` attribute — applies to every element
        // (held under HIDDEN_STYLE while parsed here).
        const styleAttr = element.getAttribute(HIDDEN_STYLE);
        if (styleAttr !== null && styleAttr.length > 0) {
            ncall(natives.setAttribute, element, HIDDEN_STYLE, rewriteCssText(styleAttr, rewriteOne));
        }

        // 5. Type-specific URL-bearing attributes (img.src, a.href, ...),
        // carrying the element's own referrer policy, if it states one; the
        // browser is then told unsafe-url (as the server's markup:
        // htmlrewrite elementReferrerPolicy).
        const attrs = urlAttrsForTagName(element.tagName);
        if (!attrs) continue;
        const rw = rewriteFor(element, rewriteOne as RewriteOne);
        if (rw !== rewriteOne) ncall(natives.setAttribute, element, "referrerpolicy", "unsafe-url");
        for (const attrName of attrs) {
            const value = element.getAttribute(attrName);
            if (value === null || value.length === 0) continue;
            const rewritten = isSrcsetAttr(attrName)
                ? rewriteSrcsetAttribute(value, rw)
                : rw(value);
            // Use the captured native setAttribute so we don't recurse through
            // our own setAttribute patch (which would rewrite again).
            ncall(natives.setAttribute, element, attrName, attrName === "src" && (element.tagName === "SCRIPT" || element.tagName === "EMBED") ? T("ScriptURL", rewritten) : rewritten);
        }
    }

    // The originals attribute, as the server writes it: what changed.
    for (const [element, was] of written) {
        const o: Record<string, string | null> = {};
        let changed = false;
        const now = new SafeMap<string, string>();
        for (const a of Array.from(element.attributes)) now.set(a.name === HIDDEN_STYLE ? "style" : a.name, a.value);
        for (const [name, value] of was) if (now.get(name) !== value) { o[name] = value; changed = true; }
        for (const name of now.keys()) if (!was.has(name)) { o[name] = null; changed = true; }
        if (changed) ncall(natives.setAttribute, element, ORIGINALS_ATTR, JSON.stringify(o));
    }

    const out = showStyleAttributes(ncall(natives.innerHTMLGet, template));
    return structural.length === 0 ? out : restoreStructuralTags(out, structural);
}

// ── Style attributes, under another name while parsed ──────────────────

const HIDDEN_STYLE = "data-crn-hs";

/** `style` attribute names in start tags renamed HIDDEN_STYLE (quotes, comments and raw text respected). */
function hideStyleAttributes(html: string): string {
    if (!/style/i.test(html)) return html;
    let out = "";
    let from = 0;
    let i = 0;
    while ((i = html.indexOf("<", i)) !== -1) {
        if (html.startsWith("<!--", i)) {
            const end = html.indexOf("-->", i + 4);
            i = end === -1 ? html.length : end + 3;
            continue;
        }
        const m = /^<([A-Za-z][^\s/>]*)/.exec(html.slice(i, i + 64));
        if (!m) { i++; continue; }
        const close = tagEnd(html, i);
        // Attributes: name [= value], after the tag name.
        let j = i + 1 + m[1]!.length;
        while (j < close) {
            const c = html[j]!;
            if (c === ">" || c === "/" || /\s/.test(c)) { j++; continue; }
            let k = j;
            while (k < close && !/[\s=>]/.test(html[k]!) && !(html[k] === "/" && html[k + 1] === ">")) k++;
            if (html.slice(j, k).toLowerCase() === "style") {
                out += html.slice(from, j) + HIDDEN_STYLE;
                from = k;
            }
            j = k;
            while (j < close && /\s/.test(html[j]!)) j++;
            if (html[j] === "=") {
                j++;
                while (j < close && /\s/.test(html[j]!)) j++;
                const q = html[j];
                if (q === '"' || q === "'") {
                    const e = html.indexOf(q, j + 1);
                    j = e === -1 ? close : e + 1;
                } else {
                    while (j < close && !/[\s>]/.test(html[j]!)) j++;
                }
            }
        }
        i = close;
        if (RAW_TEXT.test(m[1]!)) {
            const end = html.toLowerCase().indexOf("</" + m[1]!.toLowerCase(), i);
            i = end === -1 ? html.length : end;
        }
    }
    return from === 0 ? html : out + html.slice(from);
}

/** The serialization's HIDDEN_STYLE attributes named style again. */
function showStyleAttributes(html: string): string {
    return html.includes(HIDDEN_STYLE) ? html.split(" " + HIDDEN_STYLE + "=").join(" style=") : html;
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

// A <meta http-equiv="Content-Security-Policy"> content, translated for the
// proxy: spec/Csp.agda translateMeta, which is the authority (Go:
// urlrewrite.RewriteMetaCSP; both checked against the spec). Reading per
// CSP3 §2.2.1 (ASCII whitespace, names lowercased, non-ASCII directives and
// later duplicates skipped); then reports dropped, upgrade/mixed-content
// dropped on an http proxy, Trusted Types kept with the runtime's policy
// admitted, the proxy origin added to every fetch directive that is not
// exactly 'none', and a hash-pinned script/style directive falling back to
// 'unsafe-inline' 'self'. Output: "name value…" joined by "; ".
const CSP_FETCH = new SafeSet(["child-src", "connect-src", "default-src", "fenced-frame-src", "font-src", "frame-src",
    "img-src", "manifest-src", "media-src", "object-src", "prefetch-src", "script-src", "script-src-elem",
    "script-src-attr", "style-src", "style-src-elem", "style-src-attr", "worker-src"]);
const CSP_SCRIPT_STYLE = new SafeSet(["default-src", "script-src", "script-src-elem", "script-src-attr",
    "style-src", "style-src-elem", "style-src-attr"]);
const cspWords = (s: string): string[] => s.split(/[\t\n\f\r ]+/).filter((w) => w !== "");
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const isHashSource = (t: string): boolean => /^'sha(256|384|512)-/.test(asciiLower(t));
const hasCI = (vals: string[], t: string): boolean => vals.some((v) => asciiLower(v) === asciiLower(t));
const appendIfAbsent = (vals: string[], t: string): string[] => (hasCI(vals, t) ? vals : [...vals, t]);

export function rewriteCspContent(csp: string, proxyOrigin: string, ttPolicy?: string): string {
    const plainHttp = asciiLower(proxyOrigin).startsWith("http://");
    const seen = new SafeSet<string>();
    const out: string[] = [];
    for (const tok of csp.split(";")) {
        const w = cspWords(tok);
        if (w.length === 0 || /[^\x00-\x7f]/.test(tok)) continue;
        const name = asciiLower(w[0]!);
        if (seen.has(name)) continue;
        seen.add(name);
        let vals = w.slice(1);
        if (name === "report-uri" || name === "report-to") continue;
        if (plainHttp && (name === "upgrade-insecure-requests" || name === "block-all-mixed-content")) continue;
        if (name === "trusted-types") {
            vals = vals.filter((t) => asciiLower(t) !== "'none'");
            if (ttPolicy && !vals.includes(ttPolicy) && !vals.includes("*")) vals.push(ttPolicy);
        } else if (CSP_FETCH.has(name)) {
            if (CSP_SCRIPT_STYLE.has(name) && vals.some(isHashSource)) {
                vals = vals.filter((t) => { const l = asciiLower(t); return !isHashSource(t) && !l.startsWith("'nonce-") && l !== "'strict-dynamic'"; });
                vals = appendIfAbsent(appendIfAbsent(vals, "'unsafe-inline'"), "'self'");
            }
            if (proxyOrigin !== "" && !(vals.length === 1 && asciiLower(vals[0]!) === "'none'")) vals = appendIfAbsent(vals, proxyOrigin);
        }
        out.push([name, ...vals].join(" "));
    }
    return out.join("; ");
}
