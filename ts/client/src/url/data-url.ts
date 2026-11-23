// A data: URL a script is given (spec/DataUrl.agda; Go
// urlrewrite/dataurl.go): read as the browser reads it (Fetch's data: URL
// processor), its text rewritten, and given back as a data: URL of the
// rewritten text under the same MIME type — a data: URL, so a CSP that
// admits data: and not blob: runs it as directly.
//
// Written with the built-ins saved at load (a page's polyfills cannot reach
// it): indexing and char codes only.

import { sStarts } from "../native/intrinsics";

/** A data: URL as read: its MIME text as written (";base64" taken off) and its body's bytes. */
export interface DataUrl {
    head: string;
    body: number[];
}

const isAsciiWs = (c: number): boolean => c === 9 || c === 10 || c === 12 || c === 13 || c === 32;

/** Leading and trailing C0 controls and spaces off (a tab or newline left inside: outside the model, spec DataUrl.trimC0). */
function trimC0(s: string): string {
    let i = 0, j = s.length;
    while (i < j && s.charCodeAt(i) <= 0x20) i++;
    while (j > i && s.charCodeAt(j - 1) <= 0x20) j--;
    return s.slice(i, j);
}

/** The URL parser's preprocessing: leading and trailing C0 controls and spaces off, tabs and newlines removed. */
function preprocess(s: string): string {
    let i = 0, j = s.length;
    while (i < j && s.charCodeAt(i) <= 0x20) i++;
    while (j > i && s.charCodeAt(j - 1) <= 0x20) j--;
    let out = "";
    for (let k = i; k < j; k++) {
        const c = s.charCodeAt(k);
        if (c !== 9 && c !== 10 && c !== 13) out += s[k];
    }
    return out;
}

const HEX = "0123456789ABCDEF";

/** The C0 control percent-encode set (C0 controls and everything above "~"), UTF-8 bytes. */
function encodeC0(s: string): string {
    let out = "";
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0x20 && c <= 0x7e) { out += s[i]; continue; }
        let cp = c;
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
            const d = s.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) { cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
        }
        if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd; // a lone surrogate: USVString
        for (const b of utf8(cp)) out += "%" + HEX[b >> 4] + HEX[b & 15];
    }
    return out;
}

function utf8(cp: number): number[] {
    if (cp < 0x80) return [cp];
    if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 63)];
    if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
    return [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
}

function hexVal(c: number): number {
    if (c >= 48 && c <= 57) return c - 48;
    if (c >= 97 && c <= 102) return c - 87;
    if (c >= 65 && c <= 70) return c - 55;
    return -1;
}

/** Percent-decoded bytes of an ASCII string. */
function pctBytes(s: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 37 && i + 2 < s.length) {
            const a = hexVal(s.charCodeAt(i + 1)), b = hexVal(s.charCodeAt(i + 2));
            if (a >= 0 && b >= 0) { out[out.length] = a * 16 + b; i += 2; continue; }
        }
        out[out.length] = c;
    }
    return out;
}

function stripWs(s: string): string {
    let i = 0, j = s.length;
    while (i < j && isAsciiWs(s.charCodeAt(i))) i++;
    while (j > i && isAsciiWs(s.charCodeAt(j - 1))) j--;
    return s.slice(i, j);
}

const lowerAscii = (s: string): string => {
    let out = "";
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
    }
    return out;
};

/** ";" spaces* "base64" (any case) taken off the end. */
function base64Suffix(m: string): [string, boolean] {
    if (m.length < 6 || lowerAscii(m.slice(m.length - 6)) !== "base64") return [m, false];
    let r = m.slice(0, m.length - 6);
    while (r.length > 0 && r.charCodeAt(r.length - 1) === 32) r = r.slice(0, r.length - 1);
    if (r.length === 0 || r.charCodeAt(r.length - 1) !== 59) return [m, false];
    return [r.slice(0, r.length - 1), true];
}

function b64Val(c: number): number {
    if (c >= 65 && c <= 90) return c - 65;
    if (c >= 97 && c <= 122) return c - 71;
    if (c >= 48 && c <= 57) return c + 4;
    if (c === 43) return 62;
    if (c === 47) return 63;
    return -1;
}

/** Infra's forgiving-base64 decode (bytes given as code points). */
function forgivingBase64(bytes: number[]): number[] | null {
    let t: number[] = [];
    for (const b of bytes) if (!isAsciiWs(b)) t[t.length] = b;
    if (t.length % 4 === 0) {
        if (t.length >= 2 && t[t.length - 1] === 61 && t[t.length - 2] === 61) t = t.slice(0, t.length - 2);
        else if (t.length >= 1 && t[t.length - 1] === 61) t = t.slice(0, t.length - 1);
    }
    if (t.length % 4 === 1) return null;
    const out: number[] = [];
    let acc = 0, n = 0;
    for (const c of t) {
        const v = b64Val(c);
        if (v < 0) return null;
        acc = (acc << 6) | v;
        n += 6;
        if (n >= 8) {
            n -= 8;
            out[out.length] = (acc >> n) & 255;
            acc &= (1 << n) - 1;
        }
    }
    return out;
}

const TOKEN_EXTRA = "!#$%&'*+-.^_`|~";

function isToken(v: string): boolean {
    if (v.length === 0) return false;
    for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || TOKEN_EXTRA.indexOf(v[i]!) >= 0)) return false;
    }
    return true;
}

/** Chromium's own check (spec DataUrl.charsetOk): a "charset=" parameter whose value is not an HTTP token makes the URL fail. */
function charsetOk(h: string): boolean {
    for (const piece of h.split(";")) {
        const p = stripWs(piece);
        if (p.length >= 8 && lowerAscii(p.slice(0, 8)) === "charset=" && !isToken(p.slice(8))) return false;
    }
    return true;
}

/** A data: URL as read; null when it is none, does not read, or is outside the model — given as is. */
export function readDataUrl(raw: string): DataUrl | null {
    const s = trimC0(raw);
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c === 9 || c === 10 || c === 13) return null; }
    if (s.length < 5 || lowerAscii(s.slice(0, 5)) !== "data:") return null;
    let rest = s.slice(5);
    const hash = rest.indexOf("#");
    if (hash >= 0) rest = rest.slice(0, hash);
    const ser = encodeC0(rest);
    const comma = ser.indexOf(",");
    if (comma < 0) return null;
    const mime = ser.slice(0, comma);
    if (mime.indexOf("?") >= 0 || !charsetOk(stripWs(mime))) return null;
    const body = pctBytes(ser.slice(comma + 1));
    const [head, b64] = base64Suffix(stripWs(mime));
    if (!b64) return { head, body };
    const dec = forgivingBase64(body);
    return dec === null ? null : { head, body: dec };
}

function validUtf8(b: number[]): boolean {
    for (let i = 0; i < b.length;) {
        const a = b[i]!;
        const cont = (x: number | undefined): boolean => x !== undefined && x >= 0x80 && x <= 0xbf;
        const inR = (x: number | undefined, lo: number, hi: number): boolean => x !== undefined && x >= lo && x <= hi;
        if (a < 0x80) { i++; continue; }
        if (a >= 0xc2 && a <= 0xdf) { if (!cont(b[i + 1])) return false; i += 2; continue; }
        let lo = 0x80, hi = 0xbf, n = 0;
        if (a === 0xe0) { lo = 0xa0; n = 3; } else if ((a >= 0xe1 && a <= 0xec) || a === 0xee || a === 0xef) n = 3;
        else if (a === 0xed) { hi = 0x9f; n = 3; } else if (a === 0xf0) { lo = 0x90; n = 4; }
        else if (a >= 0xf1 && a <= 0xf3) n = 4; else if (a === 0xf4) { hi = 0x8f; n = 4; } else return false;
        if (!inR(b[i + 1], lo, hi)) return false;
        for (let k = 2; k < n; k++) if (!cont(b[i + k])) return false;
        i += n;
    }
    return true;
}

/** Whether the text may be rewritten (and written back as UTF-8): ASCII, or UTF-8 under no charset or charset=utf-8. */
export function rewritable(d: DataUrl): boolean {
    let ascii = true;
    for (const x of d.body) if (x >= 0x80) { ascii = false; break; }
    if (ascii) return true;
    const h = lowerAscii(d.head);
    return validUtf8(d.body) && (h.indexOf("charset=") < 0 || h.indexOf("charset=utf-8") >= 0);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(b: number[]): string {
    let out = "";
    let i = 0;
    for (; i + 2 < b.length; i += 3) {
        const n = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
        out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
    }
    if (b.length - i === 2) {
        const n = (b[i]! << 16) | (b[i + 1]! << 8);
        out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + "=";
    } else if (b.length - i === 1) {
        const n = b[i]! << 16;
        out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + "==";
    }
    return out;
}

/** "data:" <head> ";base64," <the bytes, base64>. */
export function wrapped(head: string, body: number[]): string {
    return "data:" + head + ";base64," + base64(body);
}

/** UTF-8 text of bytes (rewritable ones). */
function decodeUtf8(b: number[]): string {
    let out = "";
    for (let i = 0; i < b.length;) {
        const a = b[i]!;
        let cp: number, n: number;
        if (a < 0x80) { cp = a; n = 1; } else if (a < 0xe0) { cp = a & 31; n = 2; } else if (a < 0xf0) { cp = a & 15; n = 3; } else { cp = a & 7; n = 4; }
        for (let k = 1; k < n; k++) cp = (cp << 6) | (b[i + k]! & 63);
        out += String.fromCodePoint(cp);
        i += n;
    }
    return out;
}

/** UTF-8 bytes of text. */
function encodeUtf8(s: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
        let cp = s.charCodeAt(i);
        if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
            const d = s.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) { cp = 0x10000 + ((cp - 0xd800) << 10) + (d - 0xdc00); i++; }
        }
        if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
        for (const x of utf8(cp)) out[out.length] = x;
    }
    return out;
}

/**
 * The URL a script given `raw` gets: a data: URL of its text rewritten by
 * `rewrite`, or null when it is no data: URL, does not read, is not
 * rewritable, or rewriting changes nothing.
 */
export function rewriteDataScript(raw: string, rewrite: (text: string) => string): string | null {
    if (!sStarts(lowerAscii(trimC0(raw).slice(0, 5)), "data:")) return null;
    const d = readDataUrl(raw);
    if (!d || !rewritable(d)) return null;
    const text = decodeUtf8(d.body);
    const now = rewrite(text);
    return now === text ? null : wrapped(d.head, encodeUtf8(now));
}

/** Whether a URL string names its scheme — the only references that resolve against a data: script's own URL. */
export function namesScheme(raw: string): boolean {
    const s = preprocess(raw);
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) continue;
        if (i > 0 && ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) continue;
        return i > 0 && c === 58;
    }
    return false;
}
