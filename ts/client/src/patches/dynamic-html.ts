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

import { SafeWeakMap, SafeWeakSet, nO, nOP, nR, ncall, sLower, sStarts } from "../native/intrinsics";
import { rewriteCssText } from "../css/rewriter";
import { defaultJsRewriteOptions, rewriteJsSource } from "../js/rewriter";
import { captureNativeElementOps, contextOf, rewriteCspContent, rewriteHtmlString, rewriteSrcdoc, type ParseContext } from "./html-rewriter";
import { internalsOf } from "../native/internals";

/** The bootstrap builder of the window `node` belongs to (each window has its own base URL). */
export function bootstrapOf(node: unknown): (() => string) | undefined {
    try {
        const doc = (node as Node).ownerDocument ?? (node as Document);
        return internalsOf(doc.defaultView)?.bootstrapHtml;
    } catch {
        return undefined;
    }
}
import { rewriteSrcsetAttribute } from "./srcset";
import { elementBlobValue } from "./blob-document";
import { XLINK_NS, kindOf, rewriteByKind } from "./url-attribute-map";
import { remark, rewriteFor, type RewriteOne } from "./referrer-policy";
import { isRefreshEquiv, rewriteRefresh } from "../url/refresh";
import { rewriteAllow } from "../url/allow";
import { crossoriginValue } from "../url/crossorigin";
import { scriptKindOf } from "./script-kind";
import { isReferrerPolicy } from "../url/containment";
import { wrapAccessor, wrapMethod } from "../native/surface";
import { injectFramesIn } from "./dynamic-iframe";
import { rewriteImportMapText } from "../url/import-map";
import { consume, heldAttr, originalAttr, recordAttr, recordText, recordTextNode } from "../native/originals";
import { trustedLike, trustedPolicyName } from "../native/trusted";

/**
 * The text of a value headed for an HTML or script sink: a string, or a
 * Trusted Types object (TrustedHTML, TrustedScript, TrustedScriptURL) —
 * what a page under a Trusted Types policy passes instead of a string —
 * as the string it wraps. Null for anything else (null, undefined, …),
 * which keeps its native meaning.
 */
export function sinkText(v: unknown): string | null {
    if (typeof v === "string") return v;
    if (typeof v === "object" && v !== null && /^\[object Trusted(HTML|Script|ScriptURL)\]$/.test(ncall(nOP.toString, v))) {
        return String(v);
    }
    return null;
}

/** The Trusted Types sink an attribute is, if any: what kind of value it takes under enforcement. */
function sinkKind(el: Element, name: string): "HTML" | "Script" | "ScriptURL" | null {
    const n = name.toLowerCase();
    if (n === "srcdoc" && el.tagName === "IFRAME") return "HTML";
    if (sStarts(n, "on")) return "Script";
    if (n === "src" && (el.tagName === "SCRIPT" || el.tagName === "EMBED")) return "ScriptURL";
    if ((n === "data" || n === "codebase") && el.tagName === "OBJECT") return "ScriptURL";
    return null;
}

// Natives replaced here, for unpatchDynamicHtml (tests).
let saved: Array<[object, PropertyKey, PropertyDescriptor]> | null = null;
let patchedRealms = new SafeWeakSet<object>();

function save(holderOwner: object, key: PropertyKey): void {
    for (let o: object | null = holderOwner; o; o = nO.getPrototypeOf(o) as object | null) {
        const d = nO.getOwnPropertyDescriptor(o, key);
        if (d) { saved!.push([o, key, d]); return; }
    }
}

/**
 * Element.prototype's HTML-string and attribute entry points: markup and
 * attribute values are rewritten on the way in. Every member keeps its
 * native surface (native/surface.ts). Idempotent.
 *
 * Known gap: reading back (innerHTML, outerHTML, getAttribute) still shows
 * the rewritten markup; returning the page's own text is a separate step.
 */
export function patchDynamicHtml(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
    _unwrapOne: (url: string) => string,
    // The proxy's origin: a <meta http-equiv=CSP> in written markup (a
    // srcdoc, innerHTML) gets it added, as the server's does (smile.io's
    // launcher frame blocked its own image otherwise).
    proxyOrigin: string = "",
): void {
    const E = (targetWindow as unknown as { Element?: { prototype: Element } }).Element;
    if (!E?.prototype) return;
    const proto = E.prototype;
    const baseURI = nO.getOwnPropertyDescriptor((targetWindow as unknown as { Node: { prototype: object } }).Node.prototype, "baseURI")?.get;
    if (baseURI) scriptBases.set(targetWindow, (el) => _unwrapOne(ncall(baseURI as (this: unknown) => string, el)));
    // Once per realm: the runtime module is shared by a page and the empty
    // frames it initializes, each with prototypes of its own.
    if (patchedRealms.has(proto)) return;
    patchedRealms.add(proto);
    saved ??= [];
    captureNativeElementOps();

    save(proto, "innerHTML");
    wrapAccessor<unknown>(proto, "innerHTML", {
        set: (set, self, value) => {
            const text = sinkText(value);
            if (text === null) return ncall(set, self, value);
            // A script's or style's content is raw text — JS or CSS — not markup.
            const raw = rawText(self as Element, text, rewriteOne);
            // (Under Trusted Types the sink takes a trusted value where the
            // page gave one — native/trusted.ts.)
            ncall(set, self, raw !== null
                ? trustedLike(targetWindow, (self as Element).tagName === "SCRIPT" ? "Script" : "HTML", value, raw)
                : trustedLike(targetWindow, "HTML", value, rewriteHtmlString(text, rewriteOne, proxyOrigin, undefined, contextOf(self))));
            if (raw !== null) recordText(self as Element, raw, text);
            else { consume(self); injectFramesIn(targetWindow, self); }
        },
    });
    save(proto, "outerHTML");
    wrapAccessor<unknown>(proto, "outerHTML", {
        set: (set, self, value) => {
            const text = sinkText(value);
            const parent = (self as Node).parentNode;
            ncall(set, self, text === null ? value : trustedLike(targetWindow, "HTML", value, rewriteHtmlString(text, rewriteOne, proxyOrigin, undefined, contextOf(parent ?? self))));
            consume(parent);
            injectFramesIn(targetWindow, parent);
        },
    });
    patchRawText(targetWindow, rewriteOne);
    patchHtmlParsers(targetWindow, rewriteOne, proxyOrigin);
    save(proto, "insertAdjacentHTML");
    wrapMethod<(...a: unknown[]) => void>(proto, "insertAdjacentHTML", (native, self, args) => {
        const next = args.slice();
        const text = sinkText(next[1]);
        // The markup is parsed where it lands (HTML: insertAdjacentHTML):
        // before or after the element, in its parent; at its start or end,
        // in the element itself. Placed after a <script> (flashtalking's ad
        // tags), it was read as script text and left as written: its
        // iframe went to the origin (time.now, thehill.com).
        const where = typeof args[0] === "string" ? sLower(args[0]) : "";
        const ctx = where === "beforebegin" || where === "afterend" ? (self as Node).parentNode : self;
        if (text !== null) next[1] = trustedLike(targetWindow, "HTML", args[1], rewriteHtmlString(text, rewriteOne, proxyOrigin, undefined, contextOf(ctx)));
        nR.apply(native, self, next);
        consume((self as Node).parentNode ?? self);
        injectFramesIn(targetWindow, (self as Node).parentNode ?? self);
        return;
    });
    // setAttributeNS: an SVG image's xlink:href (Facebook's avatars) — the
    // attribute is named by its qualified name in the table, whatever
    // prefix the page gives the XLink namespace.
    save(proto, "setAttributeNS");
    wrapMethod<(...a: unknown[]) => void>(proto, "setAttributeNS", (native, self, args) => {
        if (args.length < 3 || typeof args[1] !== "string") return nR.apply(native, self, args) as void;
        const qname = args[1];
        const local = qname.slice(qname.indexOf(":") + 1);
        const name = args[0] === XLINK_NS && local.toLowerCase() === "href" ? "xlink:href" : args[0] == null || args[0] === "" ? qname : null;
        if (name === null) return nR.apply(native, self, args) as void;
        const given = typeof args[2] === "string" ? args[2] : String(args[2]);
        const v = attributeValue(self as Element, name, given, rewriteOne, proxyOrigin);
        if (v === null || v === given) return nR.apply(native, self, args) as void;
        nR.apply(native, self, [args[0], qname, v]);
        recordAttr(self as Element, qname, v, given);
        return;
    });
    save(proto, "setAttribute");
    wrapMethod<(...a: unknown[]) => void>(proto, "setAttribute", (native, self, args) => {
        if (args.length < 2 || typeof args[0] !== "string") {
            return nR.apply(native, self, args) as void;
        }
        // setAttribute stringifies its value; a Trusted Types object (a
        // TrustedScriptURL for script.src, …) is the string it wraps.
        const given = typeof args[1] === "string" ? args[1] : String(args[1]);
        const v = attributeValue(self as Element, args[0], given, rewriteOne, proxyOrigin);
        if (v === null) {
            if (args[0].toLowerCase() === "integrity") pageIntegrity.set(self as object, given);
            recordAttr(self as Element, args[0], null, given); // not applied; the page reads it back
            return;
        }
        const kind = sinkKind(self as Element, args[0]);
        nR.apply(native, self, [args[0], kind ? trustedLike(targetWindow, kind, args[1], v) : v]);
        recordAttr(self as Element, args[0], v, given);
        // Its referrer policy changed: its URLs carry the new one.
        if (args[0].toLowerCase() === "referrerpolicy") remark(self as Element, rewriteOne);
        // It became a refresh or a policy: its content as the page wrote
        // it is read again as such (or as nothing: no longer one).
        if (args[0].toLowerCase() === "http-equiv") {
            const el = self as Element;
            const o = originalAttr(el, "content");
            const was = o ? o.value : heldAttr(el, "content");
            if (was !== null) {
                const now = attributeValue(el, "content", was, rewriteOne, proxyOrigin) ?? was;
                if (now !== heldAttr(el, "content")) nR.apply(native, el, ["content", now]);
                recordAttr(el, "content", now, was);
            }
        }
        return;
    });
    patchIntegrityProperty(targetWindow);
    patchSrcdocProperty(targetWindow);
    patchAllowProperty(targetWindow);
    patchMetaProperties(targetWindow);
}

/**
 * The other ways an HTML string becomes nodes: DOMParser,
 * Range.createContextualFragment, setHTMLUnsafe (elements and shadow
 * roots), Document.parseHTMLUnsafe, and a shadow root's innerHTML. The
 * nodes they make are adopted into the page with their URLs as parsed, so
 * the markup is rewritten on the way in, as for innerHTML.
 */
function patchHtmlParsers(targetWindow: Window, rewriteOne: (url: string) => string, proxyOrigin = ""): void {
    const g = targetWindow as unknown as Record<string, ({ prototype: object } & Record<string, unknown>) | undefined>;
    const html = (v: unknown, ctx: (text: string) => ParseContext): unknown => {
        const text = sinkText(v);
        return text === null ? v : trustedLike(targetWindow, "HTML", v, rewriteHtmlString(text, rewriteOne, proxyOrigin, undefined, ctx(text)));
    };
    // How each parses (html-rewriter ParseContext): DOMParser and
    // parseHTMLUnsafe make a document with no browsing context (scripting
    // off); the others parse under a node.
    const firstArg = (proto: object | undefined, key: string, ctx: (self: unknown, text: string) => ParseContext, when: (args: unknown[]) => boolean = () => true): void => {
        if (!proto || !(key in proto)) return;
        save(proto, key);
        wrapMethod<(...a: unknown[]) => unknown>(proto, key, (native, self, args) => {
            const out = nR.apply(native, self, args.length && when(args) ? [html(args[0], (t) => ctx(self, t)), ...args.slice(1)] : args);
            // What was parsed: the returned document or fragment, or the
            // element / shadow root written into.
            consume(typeof out === "object" && out !== null ? out : self);
            injectFramesIn(targetWindow, self);
            return out;
        });
    };
    const newDocument = (): ParseContext => ({ scripting: false });
    firstArg(g["DOMParser"]?.prototype, "parseFromString", newDocument, (a) => String(a[1]).toLowerCase() === "text/html");
    // A range that starts in text parses in the text's parent (HTML:
    // createContextualFragment).
    firstArg(g["Range"]?.prototype, "createContextualFragment", (self) => {
        const start = (self as Range).startContainer;
        return contextOf(start && start.nodeType === 3 || start && start.nodeType === 4 || start && start.nodeType === 8 ? start.parentNode : start);
    });
    firstArg(g["Element"]?.prototype, "setHTMLUnsafe", (self) => contextOf(self));
    firstArg(g["ShadowRoot"]?.prototype, "setHTMLUnsafe", (self) => contextOf(self));
    firstArg(g["Document"] as unknown as object | undefined, "parseHTMLUnsafe", newDocument);
    const SR = g["ShadowRoot"]?.prototype;
    if (SR && ncall(nOP.hasOwnProperty, SR, "innerHTML")) {
        save(SR, "innerHTML");
        wrapAccessor<unknown>(SR, "innerHTML", { set: (set, self, value) => { ncall(set, self, html(value, () => contextOf(self))); consume(self); injectFramesIn(targetWindow, self); } });
    }
}

/**
 * The content of a <script> or <style> element as it must be stored: the
 * script's JS or the style's CSS, rewritten — or null when `el` is neither
 * (or a script that is not JavaScript: JSON, an import map, a template).
 */
/** Elements whose referrerpolicy governs their requests. */
function elementPolicyCapable(el: Element): boolean {
    return el.namespaceURI === "http://www.w3.org/1999/xhtml" && /^(A|AREA|IMG|IFRAME|LINK|SCRIPT)$/.test(el.tagName);
}

// Per window: an element's original base URL (its document's, <base href>
// included). Registered by patchDynamicHtml; read by rawText through the
// element's own window (a frame may share its creator's module).
const scriptBases = new SafeWeakMap<object, (el: Element) => string | null>();

/** rewriteOne, for a module's URL: marked as a script's (spec/Containment.agda Dest). */
export function asScript(rewriteOne: (url: string) => string): (url: string) => string {
    const withMark = (rewriteOne as RewriteOne).withMark;
    return withMark ? (u) => withMark(u, null, "js") : rewriteOne;
}

export function rawText(el: Element, text: string, rewriteOne: (url: string) => string): string | null {
    const tag = el.tagName;
    if (tag === "STYLE") return rewriteCssText(text, rewriteOne);
    if (tag !== "SCRIPT") return null;
    const kind = scriptKindOf(el);
    if (kind === "importmap") return rewriteImportMap(text, asScript(rewriteOne));
    if (kind !== "classic" && kind !== "module") return text;
    // As the server's: static import/export specifiers and literal import()
    // are proxified against the script's base URL, which import.meta.url
    // then is (HubSpot's islands imported straight from the origin).
    const opts = defaultJsRewriteOptions();
    let base: string | null = null;
    try {
        const win = el.ownerDocument?.defaultView;
        base = win ? scriptBases.get(win)?.(el) ?? null : null;
    } catch { base = null; }
    if (base) {
        opts.baseUrl = base;
        const rwJs = asScript(rewriteOne);
        opts.proxify = (specifier, from) => {
            try { return rwJs(new URL(specifier, from).href); } catch { return specifier; }
        };
    }
    return rewriteJsSource(text, opts);
}

/**
 * An import map with its URL-like keys, addresses and scope prefixes
 * proxified, bare specifiers as written, and "integrity" dropped (its
 * hashes are of the original modules). Mirrors Go urlrewrite.RewriteImportMap.
 */
export function rewriteImportMap(text: string, rewriteOne: (url: string) => string): string {
    return rewriteImportMapText(text, rewriteOne);
}

/**
 * The other ways a script's or style's text is set: textContent, innerText,
 * script.text, and text nodes appended to it (append/prepend/
 * replaceChildren; appendChild and insertBefore are in dynamic-iframe.ts).
 */
function patchRawText(targetWindow: Window, rewriteOne: (url: string) => string): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    const isEl = (x: unknown): x is Element => typeof x === "object" && x !== null && (x as Node).nodeType === 1;
    const setter = (proto: object | undefined, key: string): void => {
        if (!proto) return;
        save(proto, key);
        wrapAccessor<unknown>(proto, key, {
            set: (set, self, value) => {
                const text = sinkText(value);
                const raw = text !== null && isEl(self) ? rawText(self, text, rewriteOne) : null;
                ncall(set, self, raw === null ? value
                    : trustedLike(targetWindow, (self as Element).tagName === "SCRIPT" ? "Script" : "HTML", value, raw));
                if (raw !== null && text !== null) recordText(self as Element, raw, text);
            },
        });
    };
    // Wherever a prototype defines its own accessor (Node.prototype in a
    // browser; test DOMs also define them on subclasses).
    const own = (name: string, key: string): void => {
        const proto = g[name]?.prototype;
        if (proto && ncall(nOP.hasOwnProperty, proto, key)) setter(proto, key);
    };
    for (const name of ["Node", "Element", "HTMLElement", "HTMLScriptElement", "HTMLStyleElement"]) {
        own(name, "textContent");
        own(name, "innerText");
    }
    own("HTMLScriptElement", "text");
    const E = g["Element"]?.prototype;
    for (const key of ["append", "prepend", "replaceChildren"]) {
        if (!E) break;
        save(E, key);
        wrapMethod<(...a: unknown[]) => void>(E, key, (native, self, args) => {
            if (!isEl(self) || (self.tagName !== "SCRIPT" && self.tagName !== "STYLE")) return nR.apply(native, self, args) as void;
            return nR.apply(native, self, args.map((a) => rewriteTextNode(self, a, rewriteOne))) as void;
        });
    }
}

/** A string or Text node headed into a script/style: its text rewritten. */
export function rewriteTextNode(parent: Element, node: unknown, rewriteOne: (url: string) => string): unknown {
    if (typeof node === "string") {
        // As the DOM does with a string, but a text node of ours: its
        // original is kept for read-back.
        const raw = rawText(parent, node, rewriteOne);
        if (raw === null || raw === node) return node;
        const doc = parent.ownerDocument;
        if (!doc) return raw;
        const t = doc.createTextNode(raw);
        recordTextNode(t, raw, node);
        return t;
    }
    const n = node as { nodeType?: number; data?: string; childNodes?: ArrayLike<unknown> } | null;
    if (n && n.nodeType === 3 && typeof n.data === "string") {
        const was = n.data;
        const raw = rawText(parent, was, rewriteOne);
        if (raw !== null && raw !== was) { n.data = raw; recordTextNode(n as object, raw, was); }
    } else if (n && n.nodeType === 11 && n.childNodes) {
        // A fragment's text becomes the element's text (Marketo's forms
        // build their <style> that way: the CSS's images were fetched from
        // the origin, scorpion.co).
        for (let i = 0; i < n.childNodes.length; i++) rewriteTextNode(parent, n.childNodes[i], rewriteOne);
    }
    return node;
}

/** The element whose text `method` of `self` writes, when it is a <script> or <style>; else null. */
export function rawTextTarget(self: unknown, method: string): Element | null {
    const n = self as Node | null;
    if (!n) return null;
    const el = (method === "before" || method === "after" || method === "replaceWith" ? n.parentNode : n) as Element | null;
    if (!el || el.nodeType !== 1 || el.namespaceURI !== "http://www.w3.org/1999/xhtml") return null;
    return el.localName === "script" || el.localName === "style" ? el : null;
}

/** Test-only: undo the patches. */
export function unpatchDynamicHtml(): void {
    if (!saved) return;
    for (const [holder, key, d] of saved) nO.defineProperty(holder, key, d);
    saved = null;
    patchedRealms = new SafeWeakSet<object>();
}

/**
 * What setAttribute(name, value) stores, or null to store nothing.
 *   integrity — an SRI hash can never match rewritten content: not applied
 *     (the page reads back what it set: see patchIntegrityProperty);
 *   crossorigin — use-credentials, so cookies follow (except a font preload,
 *     matching its non-credentialed @font-face fetch); mirrors the server;
 *   style — CSS rewritten;
 *   a URL attribute of the element — proxified (srcset: each URL).
 */
/** An HTML <meta> whose http-equiv is refresh. */
function isRefreshMeta(el: Element): boolean {
    return el.namespaceURI === "http://www.w3.org/1999/xhtml" && el.localName === "meta" && isRefreshEquiv(heldAttr(el, "http-equiv"));
}

/** An HTML <meta> whose http-equiv is content-security-policy. */
function isCspMeta(el: Element): boolean {
    return el.namespaceURI === "http://www.w3.org/1999/xhtml" && el.localName === "meta" &&
        (heldAttr(el, "http-equiv") ?? "").replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)) === "content-security-policy";
}

function attributeValue(el: Element, name: string, value: string, rewriteOne: (url: string) => string, proxyOrigin = ""): string | null {
    const lowerName = name.toLowerCase();
    if (lowerName === "integrity") return null;
    if (lowerName === "crossorigin") {
        const html = el.namespaceURI === "http://www.w3.org/1999/xhtml";
        return crossoriginValue(html, el.localName, heldAttr(el, "rel") ?? "", heldAttr(el, "as") ?? "") ?? value;
    }
    if (lowerName === "style") return rewriteCssText(value, rewriteOne);
    // A declarative refresh navigates like a link: through the proxy (spec/Refresh.agda).
    if (lowerName === "content" && isRefreshMeta(el)) return rewriteRefresh(value, rewriteOne);
    // A policy written by script is translated as the server's is
    // (spec/Csp.agda translateMeta): the browser applies it on insertion.
    if (lowerName === "content" && proxyOrigin.length > 0 && isCspMeta(el)) return rewriteCspContent(value, proxyOrigin, trustedPolicyName());
    if (lowerName === "srcdoc" && el.tagName === "IFRAME") return rewriteSrcdoc(value, rewriteOne, proxyOrigin, bootstrapOf(el));
    // A blob: URL of a document or stylesheet the page built: rewritten (blob-document.ts).
    const blobDoc = elementBlobValue(el, lowerName, value, rewriteOne, proxyOrigin, bootstrapOf(el));
    if (blobDoc) return blobDoc;
    // An origin in allow names nothing on the proxy (spec/Allow.agda).
    if (lowerName === "allow" && el.tagName === "IFRAME") return rewriteAllow(value);
    // An element's own referrer policy: the browser is told unsafe-url, its
    // URLs carry the policy (patches/referrer-policy.ts).
    if (lowerName === "referrerpolicy" && isReferrerPolicy(value.replace(/[A-Z]/g, (c) => c.toLowerCase())) && elementPolicyCapable(el)) return "unsafe-url";
    const kind = kindOf(el, lowerName);
    if (kind === "none" || kind === "reflected") return value;
    return rewriteByKind(kind, value, rewriteFor(el, rewriteOne, lowerName), rewriteSrcsetAttribute);
}

// The integrity the page set on each element (never applied).
const pageIntegrity = new SafeWeakMap<object, string>();

/**
 * script.integrity / link.integrity: the page reads back what it set;
 * nothing reaches the element (the hash could not match rewritten content).
 */
/**
 * iframe.srcdoc reflects the attribute: setting it goes the attribute's way
 * (rewritten, with the runtime; the original kept), reading it gives what
 * the page set.
 */
function patchSrcdocProperty(targetWindow: Window): void {
    const proto = (targetWindow as unknown as { HTMLIFrameElement?: { prototype: object } }).HTMLIFrameElement?.prototype;
    if (!proto || !nO.getOwnPropertyDescriptor(proto, "srcdoc")) return;
    save(proto, "srcdoc");
    wrapAccessor<unknown>(proto, "srcdoc", {
        get: (_get, self) => (self as Element).getAttribute("srcdoc") ?? "",
        // (The value as given: a TrustedHTML stays one — setAttribute above.)
        set: (_set, self, v) => { (self as Element).setAttribute("srcdoc", (sinkText(v) === null ? String(v) : v) as string); },
    });
}

/**
 * iframe.allow reflects the attribute: set the attribute's way (its origins
 * written 'src'), read as the page set it.
 */
function patchAllowProperty(targetWindow: Window): void {
    const proto = (targetWindow as unknown as { HTMLIFrameElement?: { prototype: object } }).HTMLIFrameElement?.prototype;
    if (!proto || !nO.getOwnPropertyDescriptor(proto, "allow")) return;
    save(proto, "allow");
    wrapAccessor<unknown>(proto, "allow", {
        get: (_get, self) => (self as Element).getAttribute("allow") ?? "",
        set: (_set, self, v) => { (self as Element).setAttribute("allow", String(v)); },
    });
}

// meta.content / meta.httpEquiv reflect their attributes: set through
// setAttribute, so a refresh or a policy is translated, and read back as
// the page wrote them.
function patchMetaProperties(targetWindow: Window): void {
    const proto = (targetWindow as unknown as { HTMLMetaElement?: { prototype: object } }).HTMLMetaElement?.prototype;
    if (!proto) return;
    for (const [prop, attr] of [["content", "content"], ["httpEquiv", "http-equiv"]] as const) {
        if (!nO.getOwnPropertyDescriptor(proto, prop)) continue;
        save(proto, prop);
        wrapAccessor<unknown>(proto, prop, {
            get: (_get, self) => (self as Element).getAttribute(attr) ?? "",
            set: (_set, self, v) => { (self as Element).setAttribute(attr, String(v)); },
        });
    }
}

function patchIntegrityProperty(targetWindow: Window): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    for (const ctorKey of ["HTMLScriptElement", "HTMLLinkElement"]) {
        const proto = g[ctorKey]?.prototype;
        if (!proto) continue;
        save(proto, "integrity");
        wrapAccessor<string>(proto, "integrity", {
            get: (_get, self) => pageIntegrity.get(self as object) ?? "",
            set: (_set, self, v) => { pageIntegrity.set(self as object, String(v)); },
        });
    }
}
