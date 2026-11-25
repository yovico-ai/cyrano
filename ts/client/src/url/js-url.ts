import { rewriteJsUrlCode } from "../js/rewriter";

// javascript: URLs (spec/JsUrl.agda; Go urlrewrite/jsurl.go): the code a
// URL runs, and the URL written back with that code rewritten.

/** spec JsUrl.code: the code of a javascript: URL, or null for any other URL. */
export function jsUrlCode(s: string): string | null {
    let t = s.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
    if (/[\t\n\r]/.test(t)) t = t.replace(/[\t\n\r]/g, "");
    if (t.length < 11 || t.slice(0, 11).toLowerCase() !== "javascript:") return null;
    // Serialized (UTF-8 percent-encoding beyond ASCII), percent-decoded: the bytes.
    const bytes: number[] = [];
    const rest = t.slice(11);
    for (const ch of rest) {
        const n = ch.codePointAt(0)!;
        if (n < 0x80) bytes.push(n);
        else if (n < 0x800) bytes.push(0xc0 | (n >> 6), 0x80 | (n & 63));
        else if (n < 0x10000) bytes.push(0xe0 | (n >> 12), 0x80 | ((n >> 6) & 63), 0x80 | (n & 63));
        else bytes.push(0xf0 | (n >> 18), 0x80 | ((n >> 12) & 63), 0x80 | ((n >> 6) & 63), 0x80 | (n & 63));
    }
    const hex = (c: number | undefined): number => (c === undefined ? -1 : c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1);
    const dec: number[] = [];
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 37 && i + 2 < bytes.length) {
            const a = hex(bytes[i + 1]), b = hex(bytes[i + 2]);
            if (a >= 0 && b >= 0) { dec.push(a * 16 + b); i += 2; continue; }
        }
        dec.push(bytes[i]!);
    }
    return modelUtf8(dec);
}

/** spec Query.utf8Decode: a lead byte with its continuation bytes is one code point; any other byte U+FFFD. */
function modelUtf8(b: number[]): string {
    let out = "";
    const cont = (c: number | undefined): boolean => c !== undefined && c >= 0x80 && c < 0xc0;
    for (let i = 0; i < b.length; ) {
        const c = b[i]!;
        if (c < 0x80) { out += String.fromCharCode(c); i++; continue; }
        const n = c >= 0xc0 && c < 0xe0 ? 1 : c >= 0xe0 && c < 0xf0 ? 2 : c >= 0xf0 && c < 0xf5 ? 3 : 0;
        let ok = n > 0;
        for (let k = 1; ok && k <= n; k++) if (!cont(b[i + k])) ok = false;
        if (!ok) { out += "�"; i++; continue; }
        let r = c & (0x7f >> (n + 1));
        for (let k = 1; k <= n; k++) r = (r << 6) | (b[i + k]! & 0x3f);
        out += r > 0x10ffff ? "�" : String.fromCodePoint(r);
        i += n + 1;
    }
    return out;
}

/** spec JsUrl.encode: '%', C0 controls, space and DEL percent-encoded, nothing else. */
export function encodeJsUrlCode(code: string): string {
    let out = "";
    for (let i = 0; i < code.length; i++) {
        const c = code.charCodeAt(i);
        out += c === 37 || c < 33 || c === 127 ? "%" + "0123456789ABCDEF"[c >> 4] + "0123456789ABCDEF"[c & 15] : code[i];
    }
    return out;
}

/** spec JsUrl.rewriteUrl: a javascript: URL whose code rw changes, written back; any other URL as it is. */
export function rewriteJsUrl(s: string, rw: (code: string) => string): string {
    const code = jsUrlCode(s);
    if (code === null) return s;
    const now = rw(code);
    return now === code ? s : "javascript:" + encodeJsUrlCode(now);
}

/** A navigation's URL: a javascript: URL's code rewritten (spec/JsUrl.agda), any other URL proxified. */
export function navigationUrl(u: string, proxify: (u: string) => string): string {
    return jsUrlCode(u) !== null ? rewriteJsUrl(u, rewriteJsUrlCode) : proxify(u);
}
