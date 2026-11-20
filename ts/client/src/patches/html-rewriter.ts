// Client-side HTML rewriter: markup a page hands to the parser —
// innerHTML / outerHTML / insertAdjacentHTML, document.write, srcdoc,
// DOMParser and the other HTML parsers (dynamic-html.ts, document-write.ts).
//
// The markup is edited where it stands, as the server edits a document:
// tokenized as the browser will (spec/HtmlTok.agda; html-tokens.ts), each
// start tag's URL attributes (spec/Attrs.agda), style attribute, srcdoc,
// <meta> CSP, integrity and crossorigin edited at their spans, inline
// script and style text rewritten, the originals recorded in crn-o; every
// other character is the page's own. Nothing is parsed and serialized
// again: the parser that gets the markup builds the tree the page's markup
// builds, in whatever mode and context it is in — a chunk of
// document.write that leaves an element open leaves it open — and a
// noscript's content (text, scripting on) stays as written.

import { type RewriteOne } from "./referrer-policy";
import { scriptKind } from "./script-kind";
import { asScript, rewriteImportMap } from "./dynamic-html";
import { SafeSet, nO, ncall, aIncludes, sStarts } from "../native/intrinsics";
import { trusted, trustedPolicyName } from "../native/trusted";
import { rewriteCssText } from "../css/rewriter";
import { ORIGINALS_ATTR } from "../native/originals";
import { defaultJsRewriteOptions, rewriteJsSource } from "../js/rewriter";
import { rewriteSrcsetAttribute } from "./srcset";
import { rewriteByKind, urlAttrKind, urlDest } from "./url-attribute-map";

const lowerAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const relOf = (v: string | null): string[] => (v === null ? [] : lowerAscii(v).split(/[\t\n\f\r ]+/).filter((t) => t !== ""));
import { tokenize, withBootstrap, type Ns, type Tok, type TokAttr } from "./html-tokens";
import { isReferrerPolicy } from "../url/containment";
import { isRefreshEquiv, rewriteRefresh } from "../url/refresh";
import { rewriteAllow } from "../url/allow";
import { crossoriginValue } from "../url/crossorigin";

interface CapturedNatives {
    innerHTMLSet: (this: Element, value: string) => void;
    getAttribute: (this: Element, name: string) => string | null;
}

// The browser's own methods, saved before the runtime wraps them (the
// wrappers would come back here).
let captured: CapturedNatives | null = null;
const nativeParse = typeof DOMParser === "function" ? DOMParser.prototype.parseFromString : null;

/** Lets install.ts save the natives before it wraps Element.prototype. */
export function captureNativeElementOps(): void {
    if (captured) return;
    const d = nO.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    if (!d?.set) return;
    captured = { innerHTMLSet: d.set as CapturedNatives["innerHTMLSet"], getAttribute: Element.prototype.getAttribute };
}

/**
 * An iframe's srcdoc as the frame must get it: its markup rewritten like
 * any other, and the runtime where the server puts it (spec/HtmlTok.agda
 * bootstrapAt: after the first <head> or <body>, else before the first
 * other element) — the frame's scripts run as it is parsed, before
 * anything could be injected from outside. The frame's base URL is its
 * parent's, so the parent's rewriteOne resolves its URLs.
 */
export function rewriteSrcdoc(
    html: string,
    rewriteOne: (url: string) => string,
    proxyOrigin: string = "",
    bootstrap?: () => string,
): string {
    const rewritten = rewriteHtmlString(html, rewriteOne, proxyOrigin, bootstrap, { scripting: true });
    return bootstrap ? withBootstrap(rewritten, bootstrap()) : rewritten;
}

/**
 * How the markup's destination parses it: `scripting` (a document with a
 * browsing context: a noscript's content is text); `within`, the element
 * it is parsed in (innerHTML's context; none for a whole document).
 */
export interface ParseContext { scripting?: boolean; within?: { ns: Ns; name: string; encoding?: string | null } }

const NS: Record<string, Ns> = { "http://www.w3.org/2000/svg": "svg", "http://www.w3.org/1998/Math/MathML": "math" };

/** The parse context of markup inserted under `node` (innerHTML and the like). */
export function contextOf(node: unknown): ParseContext {
    try {
        const n = node as Node | null | undefined;
        if (!n) return {};
        const doc = n.nodeType === 9 ? (n as Document) : n.ownerDocument;
        const scripting = !!doc && doc.defaultView !== null;
        // A shadow root parses in its host.
        const el = n.nodeType === 11 ? ((n as ShadowRoot).host ?? null) : n.nodeType === 1 ? (n as Element) : null;
        if (!el) return { scripting };
        const ns = NS[el.namespaceURI ?? ""] ?? "html";
        const name = ns === "html" ? el.localName : el.localName.toLowerCase();
        return { scripting, within: { ns, name, encoding: el.getAttribute("encoding") } };
    } catch {
        return {};
    }
}

// ── Attribute values ────────────────────────────────────────────────────

let inert: Document | null | undefined;
function inertReady(): boolean {
    if (!captured) captureNativeElementOps();
    if (inert === undefined) {
        try {
            inert = nativeParse ? (ncall(nativeParse, new DOMParser(), trusted(globalThis, "HTML", "") as string, "text/html") as Document) : null;
        } catch {
            inert = null;
        }
    }
    return !!inert && !!captured;
}
/** An attribute's value as the parser reads it (character references decoded). */
function decoded(raw: string, a: TokAttr): string {
    if (a.value.indexOf("&") < 0) return a.value;
    try {
        if (!inertReady()) return a.value;
        const holder = inert!.createElement("div");
        ncall(captured!.innerHTMLSet, holder, trusted(globalThis, "HTML", "<x " + raw.slice(a.from, a.vto) + ">") as string);
        const v = holder.firstElementChild ? ncall(captured!.getAttribute, holder.firstElementChild, a.name) : null;
        return v ?? a.value;
    } catch {
        return a.value;
    }
}

/** A value written as a double-quoted attribute value. */
function quoted(v: string): string {
    let o = "\"";
    for (let k = 0; k < v.length; k++) {
        const c = v[k]!;
        o += c === "&" ? "&amp;" : c === "\"" ? "&quot;" : c;
    }
    return o + "\"";
}

/** Text written as markup text (an SVG script's or style's content). */
function escapedText(v: string): string {
    let o = "";
    for (let k = 0; k < v.length; k++) {
        const c = v[k]!;
        o += c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "\u00a0" ? "&nbsp;" : c;
    }
    return o;
}

const POLICY_TAGS = new SafeSet(["a", "area", "img", "iframe", "link", "script"]);

type Edit = [number, number, string];

/**
 * A start tag's edits: each attribute's new value at its span (the first
 * of each name: the parser drops later ones), removed ones cut out, new
 * ones (crn-o, referrerpolicy) added at the tag's end.
 */
function editStartTag(src: string, t: Extract<Tok, { kind: "start" }>, rewriteOne: RewriteOne, proxyOrigin: string,
    bootstrap: (() => string) | undefined, edits: Edit[]): void {
    if (t.ns === "math") return;
    const html = t.ns === "html";
    const first: TokAttr[] = [];
    const seen = new SafeSet<string>();
    for (const a of t.attrs) if (!seen.has(a.name)) { seen.add(a.name); first[first.length] = a; }
    const value = (n: string): string | null => {
        for (const a of first) if (a.name === n) return decoded(src, a);
        return null;
    };
    const set = new Map<string, string | null>();   // name → new value (null: removed)
    const originals: Record<string, string | null> = {};
    let changed = false;
    const change = (a: TokAttr | null, name: string, v: string | null): void => {
        const was = a ? decoded(src, a) : null;
        if (v === was) return;
        set.set(name, v);
        originals[name] = was;
        changed = true;
    };
    const attr = (n: string): TokAttr | null => {
        for (const a of first) if (a.name === n) return a;
        return null;
    };

    // An element's own referrer policy: its URLs carry it, and the browser
    // is told unsafe-url (patches/referrer-policy.ts; Go:
    // htmlrewrite elementReferrerPolicy).
    let rw: (u: string) => string = rewriteOne;
    let policyMark: string | null = null;
    if (html && POLICY_TAGS.has(t.name)) {
        const p = value("referrerpolicy");
        const lp = p === null ? null : p.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
        if (lp !== null && isReferrerPolicy(lp) && rewriteOne.withPolicy) {
            const withPolicy = rewriteOne.withPolicy;
            rw = (u) => withPolicy(u, lp);
            policyMark = lp;
            change(attr("referrerpolicy"), "referrerpolicy", "unsafe-url");
        }
    }
    const T = (kind: "HTML" | "Script" | "ScriptURL", text: string): string => trusted(globalThis, kind, text) as string;

    for (const a of first) {
        const v = decoded(src, a);
        if (a.name === "integrity") { change(a, "integrity", null); continue; }   // SRI cannot match rewritten content
        if (v === "") continue;
        if (a.name === "style") { change(a, "style", rewriteCssText(v, rewriteOne)); continue; }
        if (html && t.name === "iframe" && a.name === "srcdoc") { change(a, "srcdoc", T("HTML", rewriteSrcdoc(v, rewriteOne, proxyOrigin, bootstrap))); continue; }
        // An origin in allow names nothing on the proxy (spec/Allow.agda; Go: htmlrewrite).
        if (html && t.name === "iframe" && a.name === "allow") { const now = rewriteAllow(v); if (now !== v) change(a, "allow", now); continue; }
        // A declarative refresh navigates like a link: through the proxy
        // (spec/Refresh.agda; Go: htmlrewrite's <meta>).
        if (html && t.name === "meta" && a.name === "content" && isRefreshEquiv(value("http-equiv"))) {
            change(a, "content", rewriteRefresh(v, rewriteOne));
            continue;
        }
        if (html && t.name === "meta" && a.name === "content" && proxyOrigin.length > 0 &&
            (value("http-equiv") ?? "").toLowerCase() === "content-security-policy") {
            change(a, "content", rewriteCspContent(v, proxyOrigin, trustedPolicyName()));
            continue;
        }
        // HTML_CROSSORIGIN: use-credentials so cookies follow the proxied
        // request, alike for a resource and its preload (a preload left
        // "anonymous" is discarded and fetched twice); a font preload stays,
        // to match the anonymous @font-face fetch.
        if (a.name === "crossorigin") {
            const v2 = crossoriginValue(html, t.name, value("rel") ?? "", value("as") ?? "");
            if (v2 !== null) change(a, "crossorigin", v2);
            continue;
        }
        const kind = urlAttrKind(!html, t.name, a.name);
        if (kind === "none" || kind === "reflected") continue;
        // A script's or stylesheet's URL says so (spec/Attrs.agda urlDest).
        const as = value("as");
        const dest = urlDest(!html, t.name, a.name, relOf(value("rel")), as === null ? null : lowerAscii(as));
        const rwd = dest && rewriteOne.withMark ? (u: string) => rewriteOne.withMark!(u, policyMark, dest) : rw;
        change(a, a.name, rewriteByKind(kind, v, rwd, rewriteSrcsetAttribute));
    }
    if (!changed) return;
    set.set(ORIGINALS_ATTR, JSON.stringify(originals));

    const mine: Edit[] = [];
    let tail = "";
    for (const [name, v] of set) {
        const a = attr(name);
        if (a && v === null) mine[mine.length] = [a.from, a.vto, ""];
        else if (a && a.vfrom === a.vto) mine[mine.length] = [a.to, a.to, "=" + quoted(v!)];
        else if (a) mine[mine.length] = [a.vfrom, a.vto, quoted(v!)];
        else if (v !== null) tail += " " + name + "=" + quoted(v);
    }
    mine.sort((x, y) => x[0] - y[0]);
    for (const e of mine) edits[edits.length] = e;
    if (tail) {
        const at = t.selfClosing ? t.to - 2 : t.to - 1;
        edits[edits.length] = [at, at, tail];
    }
}

/**
 * The markup with its URLs proxified and its inline scripts and styles
 * rewritten (see the head of this file). `context`: how its destination
 * parses it.
 */
export function rewriteHtmlString(
    html: string,
    rewriteOne: (url: string) => string,
    proxyOrigin: string = "",
    bootstrap?: () => string,
    context: ParseContext = {},
): string {
    if (typeof html !== "string" || html.length === 0) return html;
    let toks: Tok[];
    try {
        toks = tokenize(html, context.scripting !== false, context.within);
    } catch {
        return html;
    }
    const edits: Edit[] = [];
    const rw = rewriteOne as RewriteOne;
    for (let k = 0; k < toks.length; k++) {
        const t = toks[k]!;
        if (t.kind !== "start") continue;
        editStartTag(html, t, rw, proxyOrigin, bootstrap, edits);
        if (t.selfClosing && t.ns !== "html") continue;
        if (t.name !== "script" && t.name !== "style") continue;
        if (t.ns === "math") continue;
        // The content: raw text up to the end tag (HTML); markup text with no
        // element in it (SVG). Left as written when its end is not in this
        // markup (a document.write chunk; the rest comes later).
        const next = toks[k + 1];
        if (!next || next.kind !== "end" || next.name !== t.name) continue;
        let text = html.slice(t.to, next.from);
        if (text.length === 0) continue;
        if (t.ns === "svg") text = decodedText(text);
        let out: string;
        if (t.name === "style") out = rewriteCssText(text, rewriteOne);
        else {
            const attrOf = (n: string): string | null => { for (const a of t.attrs) if (a.name === n) return decoded(html, a); return null; };
            if (attrOf(t.ns === "svg" ? "href" : "src") !== null || (t.ns === "svg" && attrOf("xlink:href") !== null)) continue;
            const kind = scriptKind(attrOf("type"), attrOf("language"));
            if (kind === "classic" || kind === "module") out = rewriteJsSource(text, defaultJsRewriteOptions());
            else if (kind === "importmap" && t.ns === "html") out = rewriteImportMap(text, asScript(rewriteOne));
            else continue;
        }
        edits[edits.length] = [t.to, next.from, t.ns === "svg" ? escapedText(out) : out];
    }
    if (edits.length === 0) return html;
    let out = "";
    let at = 0;
    for (const [f, t, r] of edits) { out += html.slice(at, f) + r; at = t; }
    return out + html.slice(at);
}

/** Markup text as the parser reads it (character references decoded). */
function decodedText(raw: string): string {
    if (raw.indexOf("&") < 0) return raw;
    try {
        if (!inertReady()) return raw;
        const holder = inert!.createElement("div");
        ncall(captured!.innerHTMLSet, holder, trusted(globalThis, "HTML", raw) as string);
        return holder.textContent ?? raw;
    } catch {
        return raw;
    }
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
    const plainHttp = sStarts(asciiLower(proxyOrigin), "http://");
    const seen = new SafeSet<string>();
    const out: string[] = [];
    let defaultVals: string[] | null = null;
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
            if (ttPolicy && !aIncludes(vals, ttPolicy) && !aIncludes(vals, "*")) vals.push(ttPolicy);
        } else if (CSP_FETCH.has(name)) {
            if (CSP_SCRIPT_STYLE.has(name) && vals.some(isHashSource)) {
                vals = vals.filter((t) => { const l = asciiLower(t); return !isHashSource(t) && !sStarts(l, "'nonce-") && l !== "'strict-dynamic'"; });
                vals = appendIfAbsent(appendIfAbsent(vals, "'unsafe-inline'"), "'self'");
            }
            if (proxyOrigin !== "" && !allowsNothing(vals)) vals = appendIfAbsent(vals, proxyOrigin);
            if (name === "connect-src") vals = readableCsp(vals);
        }
        if (name === "default-src") defaultVals = vals;
        out.push([name, ...vals].join(" "));
    }
    // A default-src that governs connect gets an explicit connect-src after it (spec translatePolicy).
    if (!seen.has("connect-src") && defaultVals && !allowsNothing(defaultVals)) {
        out.push(["connect-src", ...readableCsp(defaultVals)].join(" "));
    }
    return out.join("; ");
}

/** 'none', with nothing beside it but 'report-sample': a list that allows nothing (spec noneOnly). */
function allowsNothing(vals: string[]): boolean {
    let none = false;
    for (const t of vals) {
        const l = asciiLower(t);
        if (l === "'none'") none = true;
        else if (l !== "'report-sample'") return false;
    }
    return none;
}

/** What the runtime reads itself (a page's blob: / data: worker script) admitted to a connect list (spec readable). */
function readableCsp(vals: string[]): string[] {
    if (allowsNothing(vals)) return vals;
    return appendIfAbsent(appendIfAbsent(vals, "blob:"), "data:");
}
