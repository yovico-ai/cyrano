// Import maps, as cyrano hands them to the browser: a port of
// spec/ImportMap.agda, which is the authority (Go:
// urlrewrite/importmap.go; both checked against the spec, the spec's JSON
// reading against Chromium's JSON.parse).
//
// The map is edited as text: URL-like specifier keys and string addresses
// in "imports" and each scope, and every scope prefix, are replaced by
// their proxified form (JSON.stringify); "integrity"'s value becomes {};
// everything else is the page's own text. Text that is not a JSON object
// is left as written.

import { sIncludes, sPadStart } from "../native/intrinsics";
import { isUrlLikeSpecifier } from "./containment";

type TK = "ws" | "punct" | "string" | "lit";
interface Tok { kind: TK; text: string; value: string }
type Role = "keep" | "specifier" | "prefix" | "emptyObj" | "drop";
type Ctx = "top" | "specifiers" | "scopes" | "other";

const isWS = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
const isHex = (c: string | undefined): boolean => c !== undefined && /^[0-9A-Fa-f]$/.test(c);
const isLitChar = (c: string): boolean => /^[A-Za-z0-9+\-.]$/.test(c);
const isHigh = (n: number): boolean => n > 55295 && n < 56320;
const isLow = (n: number): boolean => n > 56319 && n < 57344;

function validNumber(s: string): boolean {
    return /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(s);
}

/** Tokens of JSON text (code points), or null when not JSON at the token level. */
function tokenize(src: string): Tok[] | null {
    const s = Array.from(src);
    const out: Tok[] = [];
    let i = 0;
    const four = (j: number): number | null =>
        isHex(s[j]) && isHex(s[j + 1]) && isHex(s[j + 2]) && isHex(s[j + 3]) ? parseInt(s.slice(j, j + 4).join(""), 16) : null;
    while (i < s.length) {
        const c = s[i]!;
        if (isWS(c)) {
            let j = i;
            while (j < s.length && isWS(s[j]!)) j++;
            out.push({ kind: "ws", text: s.slice(i, j).join(""), value: "" });
            i = j;
        } else if (sIncludes("{}[]:,", c)) {
            out.push({ kind: "punct", text: c, value: "" });
            i++;
        } else if (c === '"') {
            let j = i + 1, val = "", closed = false;
            while (j < s.length) {
                const d = s[j]!;
                if (d === '"') { closed = true; j++; break; }
                if (d.codePointAt(0)! < 32) return null;
                if (d !== "\\") { val += d; j++; continue; }
                const e = s[j + 1];
                if (e === "u") {
                    const n = four(j + 2);
                    if (n === null) return null;
                    if (isHigh(n) && s[j + 6] === "\\" && s[j + 7] === "u") {
                        const m = four(j + 8);
                        if (m !== null && isLow(m)) { val += String.fromCodePoint(65536 + (n - 55296) * 1024 + (m - 56320)); j += 12; continue; }
                    }
                    val += String.fromCharCode(n); j += 6; continue;
                }
                const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
                if (e === undefined || !(e in simple)) return null;
                val += simple[e]; j += 2;
            }
            if (!closed) return null;
            out.push({ kind: "string", text: s.slice(i, j).join(""), value: val });
            i = j;
        } else if (isLitChar(c)) {
            let j = i;
            while (j < s.length && isLitChar(s[j]!)) j++;
            const t = s.slice(i, j).join("");
            if (!(t === "true" || t === "false" || t === "null" || validNumber(t))) return null;
            out.push({ kind: "lit", text: t, value: "" });
            i = j;
        } else {
            return null;
        }
    }
    return out;
}

/** The role of each token, or null when the tokens are not a JSON object. */
function roles(toks: Tok[]): Role[] | null {
    const rs: Role[] = toks.map(() => "keep");
    let i = 0;
    const skip = (): void => { while (i < toks.length && toks[i]!.kind === "ws") i++; };
    const isP = (c: string): boolean => i < toks.length && toks[i]!.kind === "punct" && toks[i]!.text === c;
    const fail = (): never => { throw new SyntaxError("not JSON"); };
    const keyRole = (ctx: Ctx): Role => (ctx === "specifiers" ? "specifier" : ctx === "scopes" ? "prefix" : "keep");
    const valueRole = (ctx: Ctx): Role => (ctx === "specifiers" ? "specifier" : "keep");
    const child = (ctx: Ctx, key: string): Ctx =>
        ctx === "top" ? (key === "imports" ? "specifiers" : key === "scopes" ? "scopes" : "other") : ctx === "scopes" ? "specifiers" : "other";

    const value = (ctx: Ctx, asStr: Role): void => {
        skip();
        const t = toks[i];
        if (!t) fail();
        if (t!.kind === "string") { rs[i] = asStr; i++; return; }
        if (t!.kind === "lit") { i++; return; }
        if (isP("{")) { i++; object(ctx); return; }
        if (isP("[")) { i++; array(); return; }
        fail();
    };
    const object = (ctx: Ctx): void => {
        skip();
        if (isP("}")) { i++; return; }
        for (;;) {
            skip();
            const k = toks[i];
            if (!k || k.kind !== "string") fail();
            rs[i] = keyRole(ctx);
            i++;
            skip();
            if (!isP(":")) fail();
            i++;
            skip();
            const start = i;
            value(child(ctx, k!.value), valueRole(ctx));
            if (ctx === "top" && k!.value === "integrity") {
                rs[start] = "emptyObj";
                for (let j = start + 1; j < i; j++) rs[j] = "drop";
            }
            skip();
            if (isP(",")) { i++; continue; }
            if (isP("}")) { i++; return; }
            fail();
        }
    };
    const array = (): void => {
        skip();
        if (isP("]")) { i++; return; }
        for (;;) {
            value("other", "keep");
            skip();
            if (isP(",")) { i++; continue; }
            if (isP("]")) { i++; return; }
            fail();
        }
    };
    try {
        skip();
        if (!isP("{")) return null;
        i++;
        object("top");
        skip();
        return i === toks.length ? rs : null;
    } catch {
        return null;
    }
}

/** JSON.stringify of a string. */
function stringify(s: string): string {
    let out = '"';
    for (let k = 0; k < s.length; k++) {
        const c = s[k]!;
        const n = c.charCodeAt(0);
        const esc: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
        if (c in esc) out += esc[c];
        else if (n < 32) out += "\\u" + sPadStart(n.toString(16), 4, "0");
        else if (isHigh(n) && isLow(s.charCodeAt(k + 1))) { out += c + s[k + 1]; k++; }
        else if (isHigh(n) || isLow(n)) out += "\\u" + sPadStart(n.toString(16), 4, "0");
        else out += c;
    }
    return out + '"';
}

/** The import map, rewritten (spec rewriteImportMap): `rewriteOne` gives a URL's proxified form. */
export function rewriteImportMapText(text: string, rewriteOne: (url: string) => string): string {
    const toks = tokenize(text);
    if (!toks) return text;
    const rs = roles(toks);
    if (!rs) return text;
    let out = "";
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i]!;
        switch (rs[i]) {
            case "keep": out += t.text; break;
            case "specifier": {
                if (!isUrlLikeSpecifier(t.value)) { out += t.text; break; }
                const u = rewriteOne(t.value);
                out += u === t.value ? t.text : stringify(u);
                break;
            }
            case "prefix": {
                const u = rewriteOne(t.value);
                out += u === t.value ? t.text : stringify(u);
                break;
            }
            case "emptyObj": out += "{}"; break;
            case "drop": break;
        }
    }
    return out;
}
