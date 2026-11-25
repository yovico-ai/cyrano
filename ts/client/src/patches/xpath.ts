// XPath on URL attributes (spec/XPath.agda widenXPath).
//
// An element holds its URL attributes proxified, and XPath compares what it
// holds: `//a[@href="/p?x"]` found nothing through the proxy where natively
// it finds the link, and `string(@href)` gave the proxified URL (round J).
// As for CSS selectors (selectors.ts), the expression is widened: a
// comparison of a URL attribute with a string literal (either side, = and
// !=) also admits the value as the element holds it, unmarked and marked —
// `(@a = "v" or @a = "P" …)`, for != the conjunction. A string result that
// an element holds reads as the page wrote it (native/originals.ts
// writtenFor), any other proxified URL unwrapped. Not covered: contains() /
// starts-with() of a URL attribute; a number or boolean computed from one.

import { nO, nR, ncall } from "../native/intrinsics";
import { wrapAccessor, wrapMethod } from "../native/surface";
import { URL_ATTRS, withMarks } from "./selectors";
import { writtenFor } from "../native/originals";

const SKIPPED = /^(data|blob|javascript|mailto|tel|about):/i;
const isWS = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
const nameChar = (c: string): boolean => /[A-Za-z0-9\-_.:]/.test(c);

type Tok = { k: "lit"; q: string; v: string } | { k: "attr"; n: string } | { k: "op"; o: string } | { k: "ws"; w: string } | { k: "other"; c: string };

function lex(s: string): Tok[] {
    const out: Tok[] = [];
    let i = 0;
    while (i < s.length) {
        const c = s[i]!;
        if (c === '"' || c === "'") {
            const end = s.indexOf(c, i + 1);
            if (end < 0) { for (const x of s.slice(i)) out.push({ k: "other", c: x }); break; }
            out.push({ k: "lit", q: c, v: s.slice(i + 1, end) }); i = end + 1; continue;
        }
        if (c === "@") {
            let j = i + 1;
            while (j < s.length && nameChar(s[j]!)) j++;
            if (j === i + 1) { out.push({ k: "other", c }); i++; continue; }
            out.push({ k: "attr", n: s.slice(i + 1, j) }); i = j; continue;
        }
        if (c === "!" && s[i + 1] === "=") { out.push({ k: "op", o: "!=" }); i += 2; continue; }
        if (c === "=") { out.push({ k: "op", o: "=" }); i++; continue; }
        if (isWS(c)) { let j = i; while (j < s.length && isWS(s[j]!)) j++; out.push({ k: "ws", w: s.slice(i, j) }); i = j; continue; }
        out.push({ k: "other", c }); i++;
    }
    return out;
}

function untok(ts: Tok[]): string {
    return ts.map((t) => t.k === "lit" ? t.q + t.v + t.q : t.k === "attr" ? "@" + t.n : t.k === "op" ? t.o : t.k === "ws" ? t.w : t.c).join("");
}

/** spec/XPath.agda widenCmp: the widened comparison, or null to leave it. */
function widenCmp(rw: (u: string) => string | null, name: string, o: string, q: string, v: string): string | null {
    if (!URL_ATTRS.has(name) || v === "" || v.startsWith("#") || SKIPPED.test(v)) return null;
    const p = rw(v);
    if (p === null || p === v) return null;
    const alts = withMarks(p);
    if (alts.some((a) => a.includes('"'))) return null;
    const join = o === "=" ? " or " : " and ";
    return "(" + "@" + name + o + q + v + q + alts.map((a) => join + "@" + name + o + '"' + a + '"').join("") + ")";
}

/** spec/XPath.agda widenXPath. */
export function widenXPath(expr: string, rw: (u: string) => string | null): string {
    const ts = lex(expr);
    const out: Tok[] = [];
    const gap = (i: number): [string, number] => (ts[i]?.k === "ws" ? [(ts[i] as { w: string }).w, i + 1] : ["", i]);
    let i = 0;
    while (i < ts.length) {
        const t = ts[i]!;
        if (t.k === "attr" || t.k === "lit") {
            const [w1, j] = gap(i + 1);
            const o = ts[j];
            if (o?.k === "op") {
                const [w2, k] = gap(j + 1);
                const r = ts[k];
                const pair = t.k === "attr" && r?.k === "lit" ? { n: t.n, q: r.q, v: r.v } : t.k === "lit" && r?.k === "attr" ? { n: r.n, q: t.q, v: t.v } : null;
                if (pair) {
                    const x = widenCmp(rw, pair.n, o.o, pair.q, pair.v);
                    if (x !== null) { for (const c of x) out.push({ k: "other", c }); i = k + 1; continue; }
                    out.push(t, { k: "ws", w: w1 }, o, { k: "ws", w: w2 }, r!); i = k + 1; continue;
                }
                out.push(t, { k: "ws", w: w1 }, o, { k: "ws", w: w2 }); i = k; continue;
            }
            out.push(t, { k: "ws", w: w1 }); i = j; continue;
        }
        out.push(t); i++;
    }
    return untok(out);
}

export function patchXPath(targetWindow: Window, rewriteOne: (url: string) => string, unwrapOne: (u: string) => string): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    const rw = (u: string): string | null => { try { return rewriteOne(u); } catch { return null; } };
    const widen = (args: unknown[]): unknown[] => {
        if (!args.length || typeof args[0] !== "string") return args;
        const w = widenXPath(args[0], rw);
        return w === args[0] ? args : [w, ...args.slice(1)];
    };
    for (const [name, key] of [["Document", "evaluate"], ["Document", "createExpression"], ["XPathEvaluator", "evaluate"], ["XPathEvaluator", "createExpression"]] as const) {
        const proto = g[name]?.prototype;
        if (!proto || typeof (proto as Record<string, unknown>)[key] !== "function" || !nO.getOwnPropertyDescriptor(proto, key)) continue;
        wrapMethod<(...a: unknown[]) => unknown>(proto, key, (native, self, args) => {
            const next = widen(args);
            if (next === args) return nR.apply(native, self, args);
            // An expression the native refuses is refused in the page's own words.
            try { return nR.apply(native, self, next); } catch { return nR.apply(native, self, args); }
        });
    }
    const XR = g["XPathResult"]?.prototype;
    if (XR && nO.getOwnPropertyDescriptor(XR, "stringValue")?.get) {
        // as the page wrote it where an element holds that value (a relative URL stays relative)
        wrapAccessor<string>(XR, "stringValue", { get: (get, self) => { const v = ncall(get, self); return writtenFor(v) ?? unwrapOne(v); } });
    }
}
