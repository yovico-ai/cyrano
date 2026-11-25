// An XML document the browser renders — SVG, XHTML, XML using those
// namespaces — rewritten in place (spec/XmlDoc.agda; Go htmlrewrite/xml.go,
// of which this is a port). Every other character stays as written; a
// document that does not read as the spec reads it is returned unchanged.
// The client needs it where a page builds such a document itself: a frame
// given a data: URL of one (spec/Frames.agda dataDocument).

import { ORIGINALS_ATTR } from "../native/originals";
import { credDest, type Dest } from "../url/containment";
import { rewriteAnimUrls, urlAttrKindIn, urlDest } from "../patches/url-attribute-map";

/** The rewriters of a document's parts (the runtime's; the oracle's stand-ins in conformance). */
export interface XmlRewriters {
    url(dest: Dest | null, v: string): string; // one URL, as an attribute of that destination
    urls(s: string): string; // a URL list (ping)
    srcset(s: string): string;
    cssVal(s: string): string; // a property's value (SVG presentation attributes)
    cssDecl(s: string): string; // declarations (a style attribute)
    css(s: string): string; // a style sheet
    js(s: string): string; // a script's text, a handler's body
    sheet(s: string): string; // a stylesheet's URL (xml-stylesheet)
}

/** A root's namespace, for the bootstrap. */
export type XmlNs = "other" | "svg" | "xhtml";

export const SVG_URI = "http://www.w3.org/2000/svg";
export const XHTML_URI = "http://www.w3.org/1999/xhtml";
const XLINK_URI = "http://www.w3.org/1999/xlink";
const XML_URI = "http://www.w3.org/XML/1998/namespace";

interface XAttr { name: string; value: string; quote: string; from: number; to: number }
type XKind = "start" | "end" | "text" | "cdata" | "comment" | "doctype" | "pi";
interface XTok { kind: XKind; name: string; data: string; attrs: XAttr[]; empty: boolean; from: number; to: number }

const ws = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
const nameChar = (c: string | undefined): boolean =>
    c !== undefined && !(ws(c) || c === "/" || c === ">" || c === "=" || c === "<" || c === '"' || c === "'" || c === "?" || c === "!" || c === "&");

/** spec XmlDoc.tokenize; null when the text does not read. */
function tokenize(s: string): XTok[] | null {
    const out: XTok[] = [];
    let i = 0;
    const name = (j: number): number => { while (j < s.length && nameChar(s[j])) j++; return j; };
    const skipWs = (j: number): number => { while (j < s.length && ws(s[j])) j++; return j; };
    const tok = (kind: XKind, from: number, to: number, extra: Partial<XTok> = {}): XTok =>
        ({ kind, name: "", data: "", attrs: [], empty: false, from, to, ...extra });
    while (i < s.length) {
        if (s[i] !== "<") {
            let j = s.indexOf("<", i);
            if (j < 0) j = s.length;
            out.push(tok("text", i, j));
            i = j;
            continue;
        }
        const rest = s.slice(i + 1, i + 10);
        if (rest.startsWith("!--")) {
            const k = s.indexOf("-->", i + 4);
            if (k < 0) return null;
            out.push(tok("comment", i, k + 3));
            i = k + 3;
        } else if (rest.startsWith("![CDATA[")) {
            const k = s.indexOf("]]>", i + 9);
            if (k < 0) return null;
            out.push(tok("cdata", i, k + 3));
            i = k + 3;
        } else if (rest.startsWith("!DOCTYPE")) {
            let j = i + 9, depth = 0, q = "";
            for (; j < s.length; j++) {
                const c = s[j]!;
                if (q) { if (c === q) q = ""; continue; }
                if (c === '"' || c === "'") q = c;
                else if (c === "[") depth++;
                else if (c === "]") { if (depth > 0) depth--; }
                else if (c === ">" && depth === 0) break;
            }
            if (j >= s.length) return null;
            out.push(tok("doctype", i, j + 1));
            i = j + 1;
        } else if (rest.startsWith("?")) {
            const n = name(i + 2);
            if (n === i + 2) return null;
            const k = s.indexOf("?>", n);
            if (k < 0) return null;
            out.push(tok("pi", i, k + 2, { name: s.slice(i + 2, n), data: s.slice(n, k) }));
            i = k + 2;
        } else if (rest.startsWith("/")) {
            const n = name(i + 2);
            if (n === i + 2) return null;
            const j = skipWs(n);
            if (j >= s.length || s[j] !== ">") return null;
            out.push(tok("end", i, j + 1, { name: s.slice(i + 2, n) }));
            i = j + 1;
        } else {
            const n = name(i + 1);
            if (n === i + 1) return null;
            const t = tok("start", i, 0, { name: s.slice(i + 1, n) });
            let j = n;
            for (;;) {
                const k = skipWs(j);
                const hadWs = k > j;
                j = k;
                if (j >= s.length) return null;
                if (s[j] === ">") { j++; break; }
                if (s[j] === "/") {
                    if (s[j + 1] === ">") { t.empty = true; j += 2; break; }
                    return null;
                }
                if (!hadWs || !nameChar(s[j])) return null;
                const an = name(j);
                const a: XAttr = { name: s.slice(j, an), value: "", quote: "", from: 0, to: 0 };
                j = skipWs(an);
                if (j >= s.length || s[j] !== "=") return null;
                j = skipWs(j + 1);
                if (j >= s.length || (s[j] !== '"' && s[j] !== "'")) return null;
                a.quote = s[j]!; a.from = j;
                let e = j + 1;
                while (e < s.length && s[e] !== a.quote) { if (s[e] === "<") return null; e++; }
                if (e >= s.length) return null;
                a.value = s.slice(j + 1, e); a.to = e + 1;
                t.attrs.push(a);
                j = e + 1;
            }
            t.to = j;
            out.push(t);
            i = j;
        }
    }
    return out;
}

/** spec XmlDoc.decode: the predefined entities and character references; attr: a literal tab, CR or LF is a space. */
function decode(s: string, attr: boolean): string | null {
    if (!/[&\t\r\n]/.test(s)) return s;
    let b = "";
    for (let i = 0; i < s.length; i++) {
        let c = s[i]!;
        if (c === "&") {
            const k = s.indexOf(";", i + 1);
            if (k < 0) return null;
            const r = entity(s.slice(i + 1, k));
            if (r === null) return null;
            b += r;
            i = k;
            continue;
        }
        if (attr && (c === "\t" || c === "\n" || c === "\r")) c = " ";
        b += c;
    }
    return b;
}

function entity(n: string): string | null {
    switch (n) {
        case "lt": return "<";
        case "gt": return ">";
        case "amp": return "&";
        case "quot": return '"';
        case "apos": return "'";
    }
    let v: number;
    if (/^#x[0-9a-fA-F]+$/.test(n)) v = parseInt(n.slice(2), 16);
    else if (/^#[0-9]+$/.test(n)) v = parseInt(n.slice(1), 10);
    else return null;
    if (!(v > 0 && v < 0x110000)) return null;
    return String.fromCodePoint(v);
}

function encodeAttr(q: string, s: string): string {
    let b = "";
    for (const c of s) {
        if (c === "&") b += "&amp;";
        else if (c === "<") b += "&lt;";
        else if (c === q && c === '"') b += "&quot;";
        else if (c === q) b += "&apos;";
        else b += c;
    }
    return b;
}

const encodeText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cdataSafe = (s: string): string => s.split("]]>").join("]]]]><![CDATA[>");

function qname(n: string): { prefix: string; hasPrefix: boolean; local: string } {
    const i = n.indexOf(":");
    return i >= 0 ? { prefix: n.slice(0, i), hasPrefix: true, local: n.slice(i + 1) } : { prefix: "", hasPrefix: false, local: n };
}

interface Binding { prefix: string; isDefault: boolean; uri: string }

function lookupNs(scope: Binding[], prefix: string, isDefault: boolean): string | null {
    for (const b of scope) if (b.isDefault === isDefault && (isDefault || b.prefix === prefix)) return b.uri;
    return null;
}

interface Edit { from: number; to: number; text: string }
interface Open { name: string; scope: Binding[]; raw: 0 | 1 | 2 } // raw: 0 none, 1 CSS, 2 JS

/**
 * spec XmlDoc.rewriteXml: the document rewritten, the bootstrap (bootFor of
 * the root's namespace) placed; the document as written when it does not read.
 */
export function rewriteXml(s: string, rw: XmlRewriters, bootFor: (ns: XmlNs) => string): string {
    const toks = tokenize(s);
    if (!toks) return s;
    const edits: Edit[] = [];
    const stack: Open[] = [];
    let rooted = false, bootAt = -1, bootNs: XmlNs = "other";
    const content = (raw: 0 | 1 | 2, d: string): string => (raw === 2 ? rw.js(d) : rw.css(d));
    for (const t of toks) {
        const top = stack.length ? stack[stack.length - 1]! : null;
        switch (t.kind) {
            case "text": {
                if (!top || top.raw === 0) continue;
                const d = decode(s.slice(t.from, t.to), false);
                if (d === null) return s;
                const now = content(top.raw, d);
                if (now !== d) edits.push({ from: t.from, to: t.to, text: encodeText(now) });
                break;
            }
            case "cdata": {
                if (!top || top.raw === 0) continue;
                const d = s.slice(t.from + 9, t.to - 3);
                const now = content(top.raw, d);
                if (now !== d) edits.push({ from: t.from + 9, to: t.to - 3, text: cdataSafe(now) });
                break;
            }
            case "pi": {
                if (!rooted) { const e = stylesheetEdit(rw, t); if (e) edits.push(e); }
                break;
            }
            case "end": {
                if (!top || top.name !== t.name) return s;
                stack.pop();
                break;
            }
            case "start": {
                const bind: Binding[] = [];
                for (const a of t.attrs) {
                    const q = qname(a.name);
                    const u = decode(a.value, true);
                    if (u === null) return s;
                    if (!q.hasPrefix && q.local === "xmlns") bind.push({ prefix: "", isDefault: true, uri: u });
                    else if (q.hasPrefix && q.prefix === "xmlns") bind.push({ prefix: q.local, isDefault: false, uri: u });
                }
                const scope = [...bind, ...(top ? top.scope : [])];
                const q = qname(t.name);
                let uri: string;
                if (!q.hasPrefix) uri = lookupNs(scope, "", true) ?? "";
                else if (q.prefix === "xml") uri = XML_URI;
                else { const u = lookupNs(scope, q.prefix, false); if (u === null) return s; uri = u; }
                const ns: XmlNs = uri === SVG_URI ? "svg" : uri === XHTML_URI ? "xhtml" : "other";
                const local = q.local.toLowerCase();
                if (ns !== "other") {
                    const r = attrEdits(rw, ns === "svg", local, t.attrs, scope);
                    if (!r) return s;
                    edits.push(...r.edits);
                    // The changed attributes' originals, for read-back (spec originals).
                    if (r.was.length) {
                        const at = t.empty ? t.to - 2 : t.to - 1;
                        edits.push({ from: at, to: at, text: ` ${ORIGINALS_ATTR}="${encodeAttr('"', jsonObject(r.was))}"` });
                    }
                }
                if (!rooted && !t.empty && ns !== "other") { bootAt = t.to; bootNs = ns; }
                rooted = true;
                if (!t.empty) stack.push({ name: t.name, scope, raw: ns !== "other" ? (local === "style" ? 1 : local === "script" ? 2 : 0) : 0 });
                break;
            }
        }
    }
    if (stack.length) return s;
    let b = "", at = 0, booted = bootAt < 0;
    const emitBoot = (): void => { if (!booted) { booted = true; b += bootFor(bootNs); } };
    for (const e of edits) {
        if (!booted && bootAt <= e.from) { b += s.slice(at, bootAt); at = bootAt; emitBoot(); }
        b += s.slice(at, e.from) + e.text;
        at = e.to;
    }
    if (!booted) { b += s.slice(at, bootAt); at = bootAt; emitBoot(); }
    return b + s.slice(at);
}

/** spec jsonObject: names and values as JSON strings, '"', '\' and controls escaped (\u00xx), nothing else. */
function jsonObject(was: Array<[string, string]>): string {
    const str = (s: string): string => {
        let b = '"';
        for (const c of s) {
            const code = c.charCodeAt(0);
            if (c === '"') b += '\\"';
            else if (c === "\\") b += "\\\\";
            else if (code < 0x20) b += "\\u00" + "0123456789abcdef"[code >> 4] + "0123456789abcdef"[code & 15];
            else b += c;
        }
        return b + '"';
    };
    return "{" + was.map(([n, v]) => str(n) + ":" + str(v)).join(",") + "}";
}

function attrEdits(rw: XmlRewriters, svg: boolean, tag: string, attrs: XAttr[], scope: Binding[]): { edits: Edit[]; was: Array<[string, string]> } | null {
    const decodedOf = (name: string): string | null => {
        for (const a of attrs) if (a.name === name) return decode(a.value, true);
        return null;
    };
    const out: Edit[] = [];
    const was: Array<[string, string]> = [];
    for (const a of attrs) {
        const q = qname(a.name);
        const d = decode(a.value, true);
        if (d === null) return null;
        let key = q.local;
        if (q.hasPrefix) key = lookupNs(scope, q.prefix, false) === XLINK_URI && q.local === "href" ? "xlink:href" : q.prefix + ":" + q.local;
        let now: string;
        switch (urlAttrKindIn(svg, tag, key, decodedOf("attributeName"))) {
            case "url": {
                const rel = decodedOf("rel") ?? "";
                const as = decodedOf("as");
                const co = decodedOf("crossorigin");
                const cred = !svg && co !== null && co.trim().toLowerCase() === "use-credentials";
                now = rw.url(credDest(cred, urlDest(svg, tag, key, rel.toLowerCase().split(/[\t\n\f\r ]+/).filter((x) => x !== ""), as === null ? null : as.toLowerCase())), d);
                break;
            }
            case "animurls": now = rewriteAnimUrls(d, (u) => rw.url(null, u)); break;
            case "urllist": now = rw.urls(d); break;
            case "srcset": now = rw.srcset(d); break;
            case "css": now = rw.cssVal(d); break;
            case "handler": now = rw.js(d); break;
            case "reflected": now = d; break;
            default: now = key === "style" ? rw.cssDecl(d) : d;
        }
        if (now !== d) {
            out.push({ from: a.from, to: a.to, text: a.quote + encodeAttr(a.quote, now) + a.quote });
            was.push([a.name, d]);
        }
    }
    return { edits: out, was };
}

/** An <?xml-stylesheet href="…"?>'s href, a stylesheet's URL. */
function stylesheetEdit(rw: XmlRewriters, t: XTok): Edit | null {
    if (t.name !== "xml-stylesheet") return null;
    const base = t.from + 2 + t.name.length;
    const d = t.data;
    for (let k = 0; k + 6 <= d.length; ) {
        if (!d.startsWith("href=", k)) { k++; continue; }
        const q = d[k + 5]!;
        if (q !== '"' && q !== "'") { k += 6; continue; } // as the spec: past "href=" and the character after it
        const n = d.indexOf(q, k + 6);
        if (n < 0) return null;
        const u = decode(d.slice(k + 6, n), true);
        if (u === null) return null;
        const now = rw.sheet(u);
        if (now === u) return null;
        return { from: base + k + 5, to: base + n + 1, text: q + encodeAttr(q, now) + q };
    }
    return null;
}

/**
 * The bootstrap for an XML document whose root is in the SVG or XHTML
 * namespace (spec XmlDoc bootstrapAt; Go XMLBootstrap): the two steps as
 * script elements of the root's namespace, the second's text in CDATA.
 * `src` the runtime's URL; `init` the second step's script text.
 */
export function xmlBootstrap(ns: XmlNs, src: string, init: string): string {
    if (ns === "other") return "";
    const [uri, srcAttr, closeExternal] = ns === "svg" ? [SVG_URI, "href", "/>"] : [XHTML_URI, "src", "></script>"];
    const open = `<script xmlns="${uri}"`;
    return `${open} ${srcAttr}="${encodeAttr('"', src)}"${closeExternal}${open}><![CDATA[${cdataSafe(init)}]]></script>`;
}
