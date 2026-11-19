import type { RewriteOne } from "../patches/referrer-policy";
// Client-side CSS rewriter: the URLs in CSS text, through the proxy.
//
// A port of spec/Css.agda, which is the authority — keep this in step with
// it and with go/src/internal/cssrewrite (both checked against the spec;
// the spec against Chromium: tests/spec/css-vs-chromium). CSS Syntax 3 §4
// tokenization as far as finding URLs needs it, on code points, newlines
// read where they stand (untouched text comes back byte for byte).
//
// URLs: a url token; the first string directly inside url(); the string
// after @import; a string directly inside image-set(). One that containment
// keeps as written keeps its exact text; any other is written url("…") / "…"
// (CSSOM serialize a string).
//
// Used for inline <style>, style="…", insertRule, setProperty, cssText.

type Kind = "ws" | "comment" | "string" | "badString" | "url" | "badUrl" | "function" | "atKeyword" | "ident" | "other";
interface Tok { kind: Kind; text: string; value: string }

const cp = (c: string | undefined): number => (c === undefined ? -1 : c.codePointAt(0)!);
const isNewline = (c: string | undefined): boolean => c === "\n" || c === "\r" || c === "\f";
const isWhitespace = (c: string | undefined): boolean => isNewline(c) || c === "\t" || c === " ";
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
const isHex = (c: string | undefined): boolean => c !== undefined && /^[0-9A-Fa-f]$/.test(c);
const isAlpha = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z]$/.test(c);
const isIdentStart = (c: string | undefined): boolean => isAlpha(c) || c === "_" || cp(c) > 127;
const isNameChar = (c: string | undefined): boolean => isIdentStart(c) || isDigit(c) || c === "-";
const isNonPrintable = (c: string | undefined): boolean => {
    const n = cp(c);
    return (n >= 0 && n <= 8) || n === 11 || (n >= 14 && n <= 31) || n === 127;
};
const lowerAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const REPLACEMENT = "�";

/** The CSS tokenizer of spec/Css.agda, over code points `s` from index `i`. */
class Tokenizer {
    constructor(private readonly s: string[]) {}

    private validEscape(i: number): boolean {
        return this.s[i] === "\\" && !isNewline(this.s[i + 1]);
    }

    private startsIdent(i: number): boolean {
        const c = this.s[i];
        if (c === "-") return isIdentStart(this.s[i + 1]) || this.s[i + 1] === "-" || this.validEscape(i + 1);
        return isIdentStart(c) || this.validEscape(i);
    }

    private startsNumber(i: number): boolean {
        const c = this.s[i], d = this.s[i + 1], e = this.s[i + 2];
        if (c === "+" || c === "-") return isDigit(d) || (d === "." && isDigit(e));
        if (c === ".") return isDigit(d);
        return isDigit(c);
    }

    /** An escape after its backslash, at i: [text taken, value, next index]. */
    private escape(i: number): [string, string, number] {
        const s = this.s;
        if (i >= s.length) return ["", REPLACEMENT, i];
        if (!isHex(s[i])) return [s[i]!, s[i]!, i + 1];
        let j = i, n = 0;
        while (j < s.length && j - i < 6 && isHex(s[j])) { n = n * 16 + parseInt(s[j]!, 16); j++; }
        let text = s.slice(i, j).join("");
        if (s[j] === "\r" && s[j + 1] === "\n") { text += "\r\n"; j += 2; }
        else if (isWhitespace(s[j])) { text += s[j]; j++; }
        const ch = n === 0 || (n > 55295 && n < 57344) || n > 1114111 ? REPLACEMENT : String.fromCodePoint(n);
        return [text, ch, j];
    }

    private name(i: number): [string, string, number] {
        const s = this.s;
        let text = "", val = "";
        while (i < s.length) {
            if (s[i] === "\\") {
                if (!this.validEscape(i)) break;
                const [t, v, j] = this.escape(i + 1);
                text += "\\" + t; val += v; i = j;
            } else if (isNameChar(s[i])) {
                text += s[i]; val += s[i]; i++;
            } else break;
        }
        return [text, val, i];
    }

    private dropWS(i: number): [string, number] {
        let text = "";
        while (i < this.s.length && isWhitespace(this.s[i])) text += this.s[i++];
        return [text, i];
    }

    private remnants(i: number): [string, number] {
        const s = this.s;
        let text = "";
        while (i < s.length) {
            if (s[i] === ")") return [text + ")", i + 1];
            if (s[i] === "\\" && this.validEscape(i)) {
                const [t, , j] = this.escape(i + 1);
                text += "\\" + t; i = j;
            } else {
                text += s[i++];
            }
        }
        return [text, i];
    }

    /** A string after its opening quote q: [text, value, next, ok]. */
    private string(i: number, q: string): [string, string, number, boolean] {
        const s = this.s;
        let text = "", val = "";
        while (i < s.length) {
            const c = s[i]!;
            if (c === q) return [text + c, val, i + 1, true];
            if (isNewline(c)) return [text, val, i, false];
            if (c === "\\") {
                if (i + 1 >= s.length) return [text + "\\", val, i + 1, true];
                if (s[i + 1] === "\r" && s[i + 2] === "\n") { text += "\\\r\n"; i += 3; continue; }
                if (isNewline(s[i + 1])) { text += "\\" + s[i + 1]; i += 2; continue; }
                const [t, v, j] = this.escape(i + 1);
                text += "\\" + t; val += v; i = j;
                continue;
            }
            text += c; val += c; i++;
        }
        return [text, val, i, true];
    }

    /** A url token's body after "url(" and its whitespace: [text, value, next, ok]. */
    private url(i: number): [string, string, number, boolean] {
        const s = this.s;
        let text = "", val = "";
        while (i < s.length) {
            const c = s[i]!;
            if (c === ")") return [text + ")", val, i + 1, true];
            if (isWhitespace(c)) {
                const [w, j] = this.dropWS(i);
                if (j >= s.length) return [text + w, val, j, true];
                if (s[j] === ")") return [text + w + ")", val, j + 1, true];
                const [r, k] = this.remnants(j);
                return [text + w + r, "", k, false];
            }
            if (c === '"' || c === "'" || c === "(" || isNonPrintable(c)) {
                const [r, k] = this.remnants(i);
                return [text + r, "", k, false];
            }
            if (c === "\\") {
                if (!this.validEscape(i)) {
                    const [r, k] = this.remnants(i);
                    return [text + r, "", k, false];
                }
                const [t, v, j] = this.escape(i + 1);
                text += "\\" + t; val += v; i = j;
                continue;
            }
            text += c; val += c; i++;
        }
        return [text, val, i, true];
    }

    private number(i: number): number {
        const s = this.s;
        if (s[i] === "+" || s[i] === "-") i++;
        while (isDigit(s[i])) i++;
        if (s[i] === "." && isDigit(s[i + 1])) { i++; while (isDigit(s[i])) i++; }
        if ((s[i] === "e" || s[i] === "E") && (s[i + 1] === "+" || s[i + 1] === "-") && isDigit(s[i + 2])) { i += 2; while (isDigit(s[i])) i++; }
        else if ((s[i] === "e" || s[i] === "E") && isDigit(s[i + 1])) { i++; while (isDigit(s[i])) i++; }
        return i;
    }

    token(i: number): [Tok, number] {
        const s = this.s;
        const c = s[i]!;
        if (c === "/" && s[i + 1] === "*") {
            let j = i + 2;
            while (j < s.length && !(s[j] === "*" && s[j + 1] === "/")) j++;
            j = Math.min(j + 2, s.length);
            return [{ kind: "comment", text: s.slice(i, j).join(""), value: "" }, j];
        }
        if (isWhitespace(c)) {
            const [w, j] = this.dropWS(i);
            return [{ kind: "ws", text: w, value: "" }, j];
        }
        if (c === '"' || c === "'") {
            const [t, v, j, ok] = this.string(i + 1, c);
            return [{ kind: ok ? "string" : "badString", text: c + t, value: ok ? v : "" }, j];
        }
        if (c === "#" && (isNameChar(s[i + 1]) || this.validEscape(i + 1))) {
            const [t, , j] = this.name(i + 1);
            return [{ kind: "other", text: c + t, value: "" }, j];
        }
        if (((c === "+" || c === "-" || c === ".") && this.startsNumber(i)) || isDigit(c)) {
            let j = this.number(i);
            if (this.startsIdent(j)) j = this.name(j)[2];
            return [{ kind: "other", text: s.slice(i, j).join(""), value: "" }, j];
        }
        if (c === "-" && s[i + 1] === "-" && s[i + 2] === ">") {
            return [{ kind: "other", text: "-->", value: "" }, i + 3];
        }
        if (c === "@" && this.startsIdent(i + 1)) {
            const [t, v, j] = this.name(i + 1);
            return [{ kind: "atKeyword", text: c + t, value: lowerAscii(v) }, j];
        }
        if (this.startsIdent(i)) return this.identLike(i);
        return [{ kind: "other", text: c, value: "" }, i + 1];
    }

    private identLike(i: number): [Tok, number] {
        const s = this.s;
        const [t, v, j] = this.name(i);
        if (s[j] !== "(") return [{ kind: "ident", text: t, value: lowerAscii(v) }, j];
        if (lowerAscii(v) === "url") {
            let k = j + 1;
            while (isWhitespace(s[k])) k++;
            if (s[k] !== '"' && s[k] !== "'") {
                const [w, m] = this.dropWS(j + 1);
                const [ut, uv, n, ok] = this.url(m);
                return [{ kind: ok ? "url" : "badUrl", text: t + "(" + w + ut, value: ok ? uv : "" }, n];
            }
        }
        return [{ kind: "function", text: t + "(", value: lowerAscii(v) }, j + 1];
    }
}

function tokenize(src: string): Tok[] {
    const s = Array.from(src);
    const t = new Tokenizer(s);
    const out: Tok[] = [];
    let i = 0;
    while (i < s.length) {
        const [tok, j] = t.token(i);
        out.push(tok);
        i = j > i ? j : i + 1;
    }
    return out;
}

// importUrl / importString: an @import's — a stylesheet (spec Css roles).
type Role = "url" | "string" | "plain" | "importUrl" | "importString";

function roles(toks: Tok[]): Role[] {
    const out: Role[] = [];
    let imp = false;
    const stack: (string | null)[] = []; // innermost last: a function's name, or null for ( [ {
    const top = (): string | null | undefined => stack[stack.length - 1];
    for (const t of toks) {
        switch (t.kind) {
            case "ws": case "comment":
                out.push("plain");
                break;
            case "url":
                out.push(imp ? "importUrl" : "url"); imp = false;
                break;
            case "string": {
                const f = top();
                out.push(imp || f === "url-import" ? "importString" : f === "url" || f === "image-set" || f === "-webkit-image-set" ? "string" : "plain");
                imp = false;
                if (f === "url" || f === "url-import") stack[stack.length - 1] = "url-used";
                break;
            }
            case "atKeyword":
                out.push("plain"); imp = t.value === "import";
                break;
            case "function":
                out.push("plain"); stack.push(imp && t.value === "url" ? "url-import" : t.value); imp = false;
                break;
            default:
                out.push("plain"); imp = false;
                if (t.text === "(" || t.text === "[" || t.text === "{") stack.push(null);
                else if (t.text === ")" || t.text === "]" || t.text === "}") stack.pop();
        }
    }
    return out;
}

/** CSSOM "serialize a string". */
function serializeString(s: string): string {
    let out = '"';
    for (const c of s) {
        const n = c.codePointAt(0)!;
        if (n === 0) out += REPLACEMENT;
        else if ((n >= 1 && n <= 31) || n === 127) out += "\\" + n.toString(16) + " ";
        else if (c === '"' || c === "\\") out += "\\" + c;
        else out += c;
    }
    return out + '"';
}

/** The URLs a stylesheet names, in order (spec cssUrls). */
export function cssUrls(src: string): string[] {
    const toks = tokenize(src);
    const rs = roles(toks);
    return toks.filter((_, i) => rs[i] !== "plain").map((t) => t.value);
}

/**
 * Rewrites every URL in CSS text (spec rewriteCss): `rewriteOne` gives each
 * URL's proxified form (an @import's marked as a stylesheet's, through its
 * withMark); one it returns unchanged is kept as written.
 */
export function rewriteCssText(src: string, rewriteOne: RewriteOne): string {
    if (typeof src !== "string" || src.length === 0) return src;
    // Cheap exit: no URL can be named without one of these.
    if (!/url|import|image-set|\\/i.test(src)) return src;
    const toks = tokenize(src);
    const rs = roles(toks);
    let out = "";
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i]!;
        const r = rs[i];
        if (r === "plain") { out += t.text; continue; }
        // An @import's URL is a stylesheet's: marked so (spec rewriteCss).
        const imported = r === "importUrl" || r === "importString";
        const u = imported && rewriteOne.withMark ? rewriteOne.withMark(t.value, null, "css") : rewriteOne(t.value);
        if (u === t.value) { out += t.text; continue; }
        out += r === "url" || r === "importUrl" ? `url(${serializeString(u)})` : serializeString(u);
    }
    return out;
}
