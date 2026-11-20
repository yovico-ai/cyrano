// HTML tokenization, as far as the runtime decides things by it: a port of
// spec/HtmlTok.agda, which is the authority (Go: htmlrewrite/stream.go
// over x/net/html; both checked against the spec, the spec against
// Chromium in html-tok-vs-chromium).
//
// The tokenizer's states that decide where tokens start and end, the
// namespace each start tag's element gets (svg / math foreign content,
// integration points, breakouts), and raw text for HTML elements only.
// Positions are string indices; the characters that move a boundary are
// all ASCII, so they are the spec's positions on the same text.
//
// Plain loops and charCodeAt only: page code may have replaced Array and
// String methods by the time markup is written.

export type Ns = "html" | "svg" | "math";
/** An attribute: its name's span [from, to), its value as written, the value's span (quotes on; empty at the name's end when it has none). */
export interface TokAttr { name: string; from: number; to: number; value: string; vfrom: number; vto: number }
export type Tok =
    | { kind: "start"; name: string; attrs: TokAttr[]; selfClosing: boolean; ns: Ns; from: number; to: number }
    | { kind: "end"; name: string; from: number; to: number }
    | { kind: "comment" | "doctype" | "cdata"; from: number; to: number };

const set = (s: string): Record<string, true> => {
    const o: Record<string, true> = Object.create(null) as Record<string, true>;
    let w = "";
    for (let i = 0; i <= s.length; i++) {
        const c = i < s.length ? s[i]! : " ";
        if (c === " ") { if (w !== "") o[w] = true; w = ""; } else w += c;
    }
    return o;
};
const BREAKOUT = set("b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var");
const VOID = set("area base basefont bgsound br col embed frame hr img input keygen link meta param source track wbr");
const RAW = set("title textarea style xmp iframe noembed noframes");

type IP = "none" | "html" | "text";

const HEADINGS = set("h1 h2 h3 h4 h5 h6");
const SCOPED = set("address article aside blockquote button center details dialog dir div dl fieldset figcaption figure footer header hgroup listing main menu nav ol pre search section summary ul applet marquee object dd dt form");
const TABLE_PARTS = set("table tbody thead tfoot tr td th caption colgroup template select");
const FORMATTING = set("a b big code em font i nobr s small strike strong tt u");
const SPECIAL_HTML = set("address applet area article aside base basefont bgsound blockquote body br button caption center col colgroup dd details dir div dl dt embed fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe img input keygen li link listing main marquee menu meta nav noembed noframes noscript object ol p param plaintext pre script search section select source style summary table tbody td template textarea tfoot th thead title tr track ul wbr xmp");
const SCOPE_HTML = set("applet caption html table td th marquee object template");
const IP_SVG = set("foreignobject desc title");
const IP_MATH = set("mi mo mn ms mtext annotation-xml");
const ipName = (x: { ns: Ns; tag: string }): boolean => (x.ns === "svg" ? IP_SVG[x.tag] === true : x.ns === "math" ? IP_MATH[x.tag] === true : false);
const named = (x: Entry, t: string): boolean => !x.root && x.ns === "html" && x.tag === t;
const special = (x: Entry): boolean => x.root === true || (x.ns === "html" ? SPECIAL_HTML[x.tag] === true : ipName(x));
const scopeB = (x: Entry): boolean => x.root === true || (x.ns === "html" ? SCOPE_HTML[x.tag] === true : ipName(x));
const listB = (x: Entry): boolean => scopeB(x) || named(x, "ol") || named(x, "ul");
const buttonB = (x: Entry): boolean => scopeB(x) || named(x, "button");
const tableB = (x: Entry): boolean => x.root === true || named(x, "html") || named(x, "table") || named(x, "template");
interface Entry { tag: string; ns: Ns; ip: IP; root?: true; cdata?: boolean }

const attrValue = (as: TokAttr[], n: string): string | null => {
    for (let k = 0; k < as.length; k++) if (as[k]!.name === n) return as[k]!.value;
    return null;
};
const lower = (s: string): string => {
    let o = "";
    for (let k = 0; k < s.length; k++) {
        const n = s.charCodeAt(k);
        o += n >= 65 && n <= 90 ? String.fromCharCode(n + 32) : s[k]!;
    }
    return o;
};

function ipOf(ns: Ns, tag: string, attrs: TokAttr[]): IP {
    if (ns === "svg" && (tag === "foreignobject" || tag === "desc" || tag === "title")) return "html";
    if (ns === "math" && (tag === "mi" || tag === "mo" || tag === "mn" || tag === "ms" || tag === "mtext")) return "text";
    if (ns === "math" && tag === "annotation-xml") {
        const enc = attrValue(attrs, "encoding");
        if (enc !== null && (lower(enc) === "text/html" || lower(enc) === "application/xhtml+xml")) return "html";
    }
    return "none";
}

/** The stack of open elements, as far as namespaces go (spec startT / endT). */
class Tracker {
    private open: Entry[] = [];
    // innerHTML's context element: the root, never popped (no token made
    // it, so an annotation-xml is no HTML integration point).
    constructor(within?: { ns: Ns; name: string }) {
        if (within) this.open[0] = { tag: within.name, ns: within.ns, ip: ipOf(within.ns, within.name, []), root: true, cdata: false };
    }
    /** A token was processed: the context element now lets CDATA sections open (Chromium: none before the first). */
    settle(): void {
        const r = this.open[0];
        if (r && r.root) r.cdata = true;
    }
    private top(): Entry | undefined { return this.open.length ? this.open[this.open.length - 1] : undefined; }
    private popForeign(): void {
        for (;;) {
            const e = this.top();
            if (!e || e.root || e.ns === "html" || e.ip !== "none") return;
            this.open.length--;
        }
    }
    private foreignFor(tag: string): boolean {
        const e = this.top();
        if (!e || e.ns === "html") return false;
        if (e.ip === "html") return false;
        if (e.ip === "text" && tag !== "mglyph" && tag !== "malignmark") return false;
        return !(e.tag === "annotation-xml" && tag === "svg");
    }
    start(tag: string, attrs: TokAttr[], selfClosing: boolean): Ns {
        let ns: Ns = tag === "svg" ? "svg" : tag === "math" ? "math" : "html";
        if (this.foreignFor(tag)) {
            if (BREAKOUT[tag] || (tag === "font" && (attrValue(attrs, "color") !== null || attrValue(attrs, "face") !== null || attrValue(attrs, "size") !== null))) {
                this.popForeign();
                ns = "html";
            } else ns = this.top()!.ns;
        }
        // In HTML, an <image> is an <img> (the tree builder renames it).
        const el = ns === "html" && tag === "image" ? "img" : tag;
        const pushed = ns === "html" ? !VOID[el] : !selfClosing;
        if (pushed) this.open[this.open.length] = { tag: el, ns, ip: ipOf(ns, tag, attrs) };
        return ns;
    }
    /** An end tag (spec endT): the tree builder's end-tag rules, as far as the stack goes. */
    end(tag: string): void {
        const e = this.top();
        if (e && e.ns !== "html") {
            if (tag === "p" || tag === "br") { this.popForeign(); this.htmlEnd(tag); return; }
            // Foreign content: to the nearest foreign element of the name,
            // until an HTML element (or the context root) is reached.
            for (let k = this.open.length - 1; k >= 0; k--) {
                const x = this.open[k]!;
                if (x.root || x.ns === "html") break;
                if (x.tag === tag) { this.open.length = k; return; }
            }
        }
        this.htmlEnd(tag);
    }
    private htmlEnd(t: string): void {
        if (t === "body" || t === "html" || t === "br") return;
        if (t === "p") return this.popUntil((x) => named(x, t), buttonB);
        if (t === "li") return this.popUntil((x) => named(x, t), listB);
        if (HEADINGS[t]) return this.popUntil((x) => !x.root && x.ns === "html" && HEADINGS[x.tag] === true, scopeB);
        if (SCOPED[t]) return this.popUntil((x) => named(x, t), scopeB);
        if (TABLE_PARTS[t]) return this.popUntil((x) => named(x, t), tableB);
        if (FORMATTING[t]) return this.adoption(t);
        this.popUntil((x) => named(x, t), special);
    }
    /** Pop through the first entry m picks (from the current node down), unless a boundary b comes first. */
    private popUntil(m: (x: Entry) => boolean, b: (x: Entry) => boolean): void {
        for (let k = this.open.length - 1; k >= 0; k--) {
            const x = this.open[k]!;
            if (x.root) return;
            if (m(x)) { this.open.length = k; return; }
            if (b(x)) return;
        }
    }
    /** The adoption agency, as far as the stack goes (spec adoption). */
    private adoption(t: string): void {
        for (let round = 0; round < 8; round++) {
            let f = -1;
            for (let k = this.open.length - 1; k >= 0; k--) {
                const x = this.open[k]!;
                if (x.root) break;
                if (named(x, t)) { f = k; break; }
            }
            if (f < 0) { this.popUntil((x) => named(x, t), special); return; }
            for (let k = f + 1; k < this.open.length; k++) if (scopeB(this.open[k]!)) return;
            let fb = -1;
            for (let k = f + 1; k < this.open.length; k++) if (special(this.open[k]!)) { fb = k; break; }
            if (fb < 0) { this.open.length = f; return; }
            const F = this.open[f]!;
            const between: Entry[] = [];
            for (let k = f + 1; k < fb; k++) { const x = this.open[k]!; if (x.ns === "html" && FORMATTING[x.tag]) between[between.length] = x; }
            const next: Entry[] = [];
            for (let k = 0; k < f; k++) next[next.length] = this.open[k]!;
            for (const x of between) next[next.length] = x;
            next[next.length] = this.open[fb]!;
            next[next.length] = { tag: F.tag, ns: F.ns, ip: F.ip };
            for (let k = fb + 1; k < this.open.length; k++) next[next.length] = this.open[k]!;
            this.open = next;
        }
    }
    cdataAllowed(): boolean {
        const e = this.top();
        // Where the next token is foreign content (Chromium): not at an integration point.
        return e !== undefined && (!e.root || e.cdata === true) && e.ns !== "html" && e.ip === "none";
    }
}

const enum S {
    Data, TagOpen, EndOpen, TagName, BeforeAttr, AttrName, AfterAttr, BeforeValue, ValueQ, ValueU, AfterValueQ, SelfClose,
    Doctype, Bogus, CStart, CStartDash, CBody, CEndDash, CEnd, CEndBang, Cdata, CdataB, CdataBB,
    Raw, RawLt, RawEndOpen, RawEndName,
    Scr, ScrLt, ScrEndOpen, ScrEndName, EscStart, EscStartDash, Esc, EscD, EscDD, EscLt, EscEndOpen, EscEndName,
    DblStart, Dbl, DblD, DblDD, DblLt, DblEnd, Plaintext,
}

const isWS = (n: number): boolean => n === 9 || n === 10 || n === 12 || n === 13 || n === 32;
const isAlpha = (n: number): boolean => (n >= 65 && n <= 90) || (n >= 97 && n <= 122);
const low = (n: number): string => String.fromCharCode(n >= 65 && n <= 90 ? n + 32 : n);

/**
 * The tokens of markup (spec `tokens`): `scripting` makes noscript raw text.
 * `tail`, when given, is set to where an unfinished construct at the end
 * begins — a tag, comment, doctype or CDATA section, or the start tag of a
 * script or raw-text element whose end tag has not come — or -1.
 */
export function tokenize(s: string, scripting: boolean, within?: { ns: Ns; name: string; encoding?: string | null }, tail?: { at: number }): Tok[] {
    const out: Tok[] = [];
    const tr = new Tracker(within);
    const n = s.length;
    let st: S = S.Data as S;
    let i = 0;
    let p = 0;           // where the current token began
    let end = false;     // the tag is an end tag
    let name = "";       // tag name
    let attrs: TokAttr[] = [];
    let an = "", af = 0; // attribute name, where it began
    let q = 0;           // the quote of a quoted value
    let v = "";          // attribute value
    let vf = 0;          // where the value began
    let buf = "";        // temporary buffer (end tag names in raw text, double escapes)
    let rawName = "";    // the element whose end tag ends RAW
    let rawFrom = -1;    // where the start tag of the open script / raw-text element began
    let inRaw = false;   // inside one (its end tag not yet emitted)
    if (tail) tail.at = -1;
    const push = (t: Tok): void => { out[out.length] = t; tr.settle(); };
    const setV = (vt: number): void => {
        if (!attrs.length) return;
        const a = attrs[attrs.length - 1]!;
        a.value = v; a.vfrom = vf; a.vto = vt;
    };
    const emitTag = (to: number, selfClosing: boolean): void => {
        if (end) {
            push({ kind: "end", name, from: p, to });
            tr.end(name);
            st = S.Data;
            inRaw = false;
            return;
        }
        const ns = tr.start(name, attrs, selfClosing);
        push({ kind: "start", name, attrs, selfClosing, ns, from: p, to });
        st = S.Data;
        rawFrom = p;
        if (ns === "html") {
            if (name === "script") { st = S.Scr; inRaw = true; }
            else if (name === "plaintext") st = S.Plaintext;
            else if (RAW[name] || (scripting && name === "noscript")) { st = S.Raw; rawName = name; inRaw = true; }
        }
    };
    const eofToken = (): void => {
        switch (st) {
            case S.Doctype: push({ kind: "doctype", from: p, to: n }); break;
            case S.Bogus: case S.CStart: case S.CStartDash: case S.CBody: case S.CEndDash: case S.CEnd: case S.CEndBang:
                push({ kind: "comment", from: p, to: n }); break;
            case S.Cdata: case S.CdataB: case S.CdataBB: push({ kind: "cdata", from: p, to: n }); break;
            default: break;
        }
    };
    const startTag = (isEnd: boolean, c: number): void => { end = isEnd; name = low(c); attrs = []; st = S.TagName; };
    const startAttr = (at: number, first: string): void => { an = first; af = at; st = S.AttrName; };
    // An end tag ending raw text (the name in buf matched): the tag states take it from here.
    const rawEnd = (c: number, at: number, nm: string): boolean => {
        if (buf !== nm) return false;
        if (isWS(c)) { end = true; name = nm; attrs = []; st = S.BeforeAttr; return true; }
        if (c === 47) { end = true; name = nm; attrs = []; st = S.SelfClose; return true; }
        if (c === 62) { end = true; name = nm; attrs = []; emitTag(at + 1, false); return true; }
        return false;
    };

    // innerHTML in an element whose content is raw text: the tokenizer
    // starts there and no end tag is appropriate — all text, no token
    // (spec tokensIn; HTML "parsing HTML fragments").
    if (within && within.ns === "html") {
        const w = within.name;
        if (w === "script" || w === "plaintext" || RAW[w] || (scripting && w === "noscript")) return out;
    }
    while (i < n) {
        const c = s.charCodeAt(i);
        switch (st) {
            case S.Data:
                if (c === 60) { p = i; st = S.TagOpen; } else tr.settle();
                i++; break;
            case S.TagOpen:
                if (c === 33) { // markup declaration
                    if (s.charCodeAt(i + 1) === 45 && s.charCodeAt(i + 2) === 45) { st = S.CStart; i += 3; break; }
                    const seven = s.slice(i + 1, i + 8);
                    if (seven.length === 7 && lower(seven) === "doctype") { st = S.Doctype; i += 8; break; }
                    if (seven === "[CDATA[" && tr.cdataAllowed()) { st = S.Cdata; i += 8; break; }
                    st = S.Bogus; i++; break;
                }
                if (c === 47) { st = S.EndOpen; i++; break; }
                if (isAlpha(c)) { startTag(false, c); i++; break; }
                if (c === 63) { st = S.Bogus; i++; break; }
                tr.settle();
                st = S.Data; break;
            case S.EndOpen:
                if (isAlpha(c)) { startTag(true, c); i++; break; }
                if (c === 62) { tr.settle(); st = S.Data; i++; break; }
                st = S.Bogus; break;
            case S.TagName:
                if (isWS(c)) st = S.BeforeAttr;
                else if (c === 47) st = S.SelfClose;
                else if (c === 62) emitTag(i + 1, false);
                else name += low(c);
                i++; break;
            case S.BeforeAttr:
                if (isWS(c)) { i++; break; }
                if (c === 47 || c === 62) { st = S.AfterAttr; break; }
                startAttr(i, low(c)); i++; break;
            case S.AttrName:
                if (isWS(c) || c === 47 || c === 62) { attrs[attrs.length] = { name: an, from: af, to: i, value: "", vfrom: i, vto: i }; st = S.AfterAttr; break; }
                if (c === 61) { attrs[attrs.length] = { name: an, from: af, to: i, value: "", vfrom: i, vto: i }; st = S.BeforeValue; i++; break; }
                an += low(c); i++; break;
            case S.AfterAttr:
                if (isWS(c)) { i++; break; }
                if (c === 47) { st = S.SelfClose; i++; break; }
                if (c === 61) { st = S.BeforeValue; i++; break; }
                if (c === 62) { emitTag(i + 1, false); i++; break; }
                startAttr(i, low(c)); i++; break;
            case S.BeforeValue:
                if (isWS(c)) { i++; break; }
                if (c === 34 || c === 39) { q = c; v = ""; vf = i; st = S.ValueQ; i++; break; }
                if (c === 62) { emitTag(i + 1, false); i++; break; }
                v = s[i]!; vf = i; st = S.ValueU; i++; break;
            case S.ValueQ:
                if (c === q) { setV(i + 1); st = S.AfterValueQ; } else v += s[i]!;
                i++; break;
            case S.ValueU:
                if (isWS(c)) { setV(i); st = S.BeforeAttr; }
                else if (c === 62) { setV(i); emitTag(i + 1, false); }
                else v += s[i]!;
                i++; break;
            case S.AfterValueQ:
                if (isWS(c)) { st = S.BeforeAttr; i++; break; }
                if (c === 47) { st = S.SelfClose; i++; break; }
                if (c === 62) { emitTag(i + 1, false); i++; break; }
                st = S.BeforeAttr; break;
            case S.SelfClose:
                if (c === 62) { emitTag(i + 1, true); i++; break; }
                st = S.BeforeAttr; break;
            case S.Doctype:
                if (c === 62) { push({ kind: "doctype", from: p, to: i + 1 }); st = S.Data; }
                i++; break;
            case S.Bogus:
                if (c === 62) { push({ kind: "comment", from: p, to: i + 1 }); st = S.Data; }
                i++; break;
            case S.CStart:
                if (c === 45) { st = S.CStartDash; i++; break; }
                if (c === 62) { push({ kind: "comment", from: p, to: i + 1 }); st = S.Data; i++; break; }
                st = S.CBody; break;
            case S.CStartDash:
                if (c === 45) { st = S.CEnd; i++; break; }
                if (c === 62) { push({ kind: "comment", from: p, to: i + 1 }); st = S.Data; i++; break; }
                st = S.CBody; break;
            case S.CBody:
                if (c === 45) st = S.CEndDash;
                i++; break;
            case S.CEndDash:
                if (c === 45) { st = S.CEnd; i++; break; }
                st = S.CBody; break;
            case S.CEnd:
                if (c === 62) { push({ kind: "comment", from: p, to: i + 1 }); st = S.Data; i++; break; }
                if (c === 33) { st = S.CEndBang; i++; break; }
                if (c === 45) { i++; break; }
                st = S.CBody; break;
            case S.CEndBang:
                if (c === 45) { st = S.CEndDash; i++; break; }
                if (c === 62) { push({ kind: "comment", from: p, to: i + 1 }); st = S.Data; i++; break; }
                st = S.CBody; break;
            case S.Cdata:
                if (c === 93) st = S.CdataB;
                i++; break;
            case S.CdataB:
                if (c === 93) { st = S.CdataBB; i++; break; }
                st = S.Cdata; break;
            case S.CdataBB:
                if (c === 93) { i++; break; }
                if (c === 62) { push({ kind: "cdata", from: p, to: i + 1 }); st = S.Data; i++; break; }
                st = S.Cdata; break;
            case S.Raw:
                if (c === 60) { p = i; st = S.RawLt; }
                i++; break;
            case S.RawLt:
                if (c === 47) { st = S.RawEndOpen; i++; break; }
                st = S.Raw; break;
            case S.RawEndOpen:
                if (isAlpha(c)) { buf = low(c); st = S.RawEndName; i++; break; }
                st = S.Raw; break;
            case S.RawEndName:
                if (isAlpha(c)) { buf += low(c); i++; break; }
                if (rawEnd(c, i, rawName)) { i++; break; }
                st = S.Raw; break;
            case S.Scr:
                if (c === 60) { p = i; st = S.ScrLt; }
                i++; break;
            case S.ScrLt:
                if (c === 47) { st = S.ScrEndOpen; i++; break; }
                if (c === 33) { st = S.EscStart; i++; break; }
                st = S.Scr; break;
            case S.ScrEndOpen:
                if (isAlpha(c)) { buf = low(c); st = S.ScrEndName; i++; break; }
                st = S.Scr; break;
            case S.ScrEndName:
                if (isAlpha(c)) { buf += low(c); i++; break; }
                if (rawEnd(c, i, "script")) { i++; break; }
                st = S.Scr; break;
            case S.EscStart:
                if (c === 45) { st = S.EscStartDash; i++; break; }
                st = S.Scr; break;
            case S.EscStartDash:
                if (c === 45) { st = S.EscDD; i++; break; }
                st = S.Scr; break;
            case S.Esc:
                if (c === 45) st = S.EscD;
                else if (c === 60) { p = i; st = S.EscLt; }
                i++; break;
            case S.EscD:
                if (c === 45) st = S.EscDD;
                else if (c === 60) { p = i; st = S.EscLt; }
                else st = S.Esc;
                i++; break;
            case S.EscDD:
                if (c === 45) { /* stay */ }
                else if (c === 60) { p = i; st = S.EscLt; }
                else if (c === 62) st = S.Scr;
                else st = S.Esc;
                i++; break;
            case S.EscLt:
                if (c === 47) { st = S.EscEndOpen; i++; break; }
                if (isAlpha(c)) { buf = ""; st = S.DblStart; break; }
                st = S.Esc; break;
            case S.EscEndOpen:
                if (isAlpha(c)) { buf = low(c); st = S.EscEndName; i++; break; }
                st = S.Esc; break;
            case S.EscEndName:
                if (isAlpha(c)) { buf += low(c); i++; break; }
                if (rawEnd(c, i, "script")) { i++; break; }
                st = S.Esc; break;
            case S.DblStart:
                if (isWS(c) || c === 47 || c === 62) { st = buf === "script" ? S.Dbl : S.Esc; i++; break; }
                if (isAlpha(c)) { buf += low(c); i++; break; }
                st = S.Esc; break;
            case S.Dbl:
                if (c === 45) st = S.DblD;
                else if (c === 60) st = S.DblLt;
                i++; break;
            case S.DblD:
                if (c === 45) st = S.DblDD;
                else if (c === 60) st = S.DblLt;
                else st = S.Dbl;
                i++; break;
            case S.DblDD:
                if (c === 45) { /* stay */ }
                else if (c === 60) st = S.DblLt;
                else if (c === 62) st = S.Scr;
                else st = S.Dbl;
                i++; break;
            case S.DblLt:
                if (c === 47) { buf = ""; st = S.DblEnd; i++; break; }
                st = S.Dbl; break;
            case S.DblEnd:
                if (isWS(c) || c === 47 || c === 62) { st = buf === "script" ? S.Esc : S.Dbl; i++; break; }
                if (isAlpha(c)) { buf += low(c); i++; break; }
                st = S.Dbl; break;
            case S.Plaintext:
                i = n; break;
        }
    }
    if (tail) tail.at = inRaw ? rawFrom : st === S.Data || st === S.Plaintext ? -1 : p;
    eofToken();
    return out;
}

/** Where the bootstrap goes in a document (spec bootstrapAt), or -1: nowhere. */
export function bootstrapAt(s: string): number {
    const ts = tokenize(s, true);
    for (let k = 0; k < ts.length; k++) {
        const t = ts[k]!;
        if (t.kind !== "start" || t.name === "html") continue;
        return t.name === "head" || t.name === "body" ? t.to : t.from;
    }
    return -1;
}

/** The document with `boot` where the bootstrap goes (spec withBootstrap). */
export function withBootstrap(s: string, boot: string): string {
    const at = bootstrapAt(s);
    return at < 0 ? s : s.slice(0, at) + boot + s.slice(at);
}
