// CSS selectors on URL attributes, in the DOM's lookup methods.
//
// An element holds its URL attributes proxied, and a selector is matched
// against what the element holds: `script[src="https://cdn.example/a.js"]`
// finds nothing under the proxy, where natively it finds the script. Sites
// look for what they have already loaded this way and, finding nothing,
// load it again (Squarespace runs its component scripts twice: "… is
// already defined").
//
// querySelector / querySelectorAll / matches / closest are given a selector
// in which each `[attr="value"]` and `[attr^="value"]` on a URL attribute
// also admits the value as the element holds it:
//
//     [src="V"]   →  :is([src="V"], [src="proxied(V)"])
//     [href^="V"] →  :is([href^="V"], [href^="proxied(V)"])
//
// `*=` and `$=` admit the proxied form of a value naming a host after
// `//`, with or without (the end of) a scheme before it
// (`[src*="//html-load.com/loader.min.js"]`, Ad-Shield's recovery code
// finding its loader; `[src$="ps://cdn/a.js"]`): the proxied URL has
// `/cyrano/https/host/…` there. Any other `*=` or `$=` value is left alone:
// a part or the end of the original URL past its host is still one of the
// proxied URL.
//
// Each proxied value is admitted with the destination marks an element's
// URL can carry (`/cyrano/https!js/…` on a script's src, `!css` on a
// stylesheet's href): without them `script[src="…"]` found nothing again.
// On srcset / imagesrcset, an = or ^= of one URL (no whitespace, no comma:
// the first candidate's URL or its beginning) is widened the same way
// (Adobe's Edge Delivery: source[srcset^="./media_"]).
// spec/Selectors.agda is the authority (checked: selectors-conformance;
// the spec against Chromium: selectors-vs-chromium). Not covered: a value
// written relative in a `*=` / `$=` test (the element holds it resolved),
// an element whose URL carries a referrer-policy mark.
//
// Heuristic: the value is proxied as the page's own URL text would be; a
// page that writes one form in the attribute and another in the selector
// (relative here, absolute there) now matches where natively it would not.
// Selectors in stylesheets are not covered.

import { SafeSet, nOP, nR, ncall, sEnds, sStarts } from "../native/intrinsics";
import { wrapMethod } from "../native/surface";

const URL_ATTRS = new SafeSet([
    "src", "href", "action", "formaction", "poster", "data", "background", "cite", "manifest", "ping", "attributionsrc", "xlink:href",
]);

/** `selector` with URL-attribute tests widened to the proxied values; the same string when there is none. */
export function widenSelector(selector: string, rewriteOne: (url: string) => string, proxyBase: string): string {
    if (selector.indexOf("[") < 0) return selector;
    let out = "";
    let i = 0;
    let changed = false;
    while (i < selector.length) {
        const c = selector[i]!;
        if (c === '"' || c === "'") { // a string outside brackets (in :not("…") never; kept whole anyway)
            const end = stringEnd(selector, i);
            out += selector.slice(i, end);
            i = end;
            continue;
        }
        if (c === "\\") { out += selector.slice(i, i + 2); i += 2; continue; }
        if (c !== "[") { out += c; i++; continue; }
        const end = bracketEnd(selector, i);
        if (end < 0) return selector; // malformed: the native reports it
        const whole = selector.slice(i, end + 1);
        const wide = widenAttribute(whole, rewriteOne, proxyBase);
        if (wide !== whole) changed = true;
        out += wide;
        i = end + 1;
    }
    return changed ? out : selector;
}

function stringEnd(s: string, start: number): number {
    const q = s[start];
    for (let i = start + 1; i < s.length; i++) {
        if (s[i] === "\\") { i++; continue; }
        if (s[i] === q) return i + 1;
    }
    return s.length;
}

function bracketEnd(s: string, start: number): number {
    for (let i = start + 1; i < s.length; i++) {
        const c = s[i];
        if (c === "\\") { i++; continue; }
        if (c === '"' || c === "'") { i = stringEnd(s, i) - 1; continue; }
        if (c === "]") return i;
    }
    return -1;
}

// [ name op value flags? ]
const ATTR = /^\[\s*([A-Za-z_][\w-]*)\s*(=|\^=|\*=|\$=)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s\]"']+))\s*([iIsS])?\s*\]$/;

/** A proxied URL as an element may hold it: unmarked, and marked js and css (spec/Containment.agda Mark). */
function withMarks(proxied: string): string[] {
    const at = proxied.indexOf("/cyrano/");
    if (at < 0) return [proxied];
    const segEnd = proxied.indexOf("/", at + 8);
    if (segEnd < 0 || proxied.slice(at + 8, segEnd).indexOf("!") >= 0) return [proxied];
    return [proxied, `${proxied.slice(0, segEnd)}!js${proxied.slice(segEnd)}`, `${proxied.slice(0, segEnd)}!css${proxied.slice(segEnd)}`];
}

function widenAttribute(whole: string, rewriteOne: (url: string) => string, proxyBase: string): string {
    const m = ATTR.exec(whole);
    if (!m) return whole;
    const name = m[1]!;
    const lname = name.toLowerCase();
    const srcsetLike = lname === "srcset" || lname === "imagesrcset";
    if (!URL_ATTRS.has(lname) && !srcsetLike) return whole;
    const op = m[2]!;
    const raw = m[3] ?? m[4] ?? m[5] ?? "";
    const value = raw.replace(/\\([0-9a-fA-F]{1,6}\s?|[\s\S])/g, (_e, x: string) =>
        /^[0-9a-fA-F]/.test(x) ? String.fromCodePoint(parseInt(x.trim(), 16)) : x);
    if (value === "" || sStarts(value, "#") || /^(data|blob|javascript|mailto|tel|about):/i.test(value)) return whole;
    // A srcset: only an = or ^= of one URL (the first candidate's, or its beginning).
    if (srcsetLike && !((op === "=" || op === "^=") && !/[\t\n\f\r ,]/.test(value))) return whole;
    const alternatives: string[] = [];
    if (op === "*=" || op === "$=") {
        // Only a value naming a host after "//", the end of a scheme (or
        // none) before it: "https://h/p", "ps://h/p", "://h/p", "//h/p".
        const m2 = /^(?:([a-z]*):)?\/\/([^/?#\s]+.*)$/i.exec(value);
        if (!m2) return whole;
        const letters = (m2[1] ?? "").toLowerCase();
        const schemes = m2[1] === undefined ? ["https", "http"] : ["https", "http"].filter((sc) => sEnds(sc, letters));
        if (schemes.length === 0) return whole;
        for (const sc of schemes) {
            let proxied: string;
            try { proxied = rewriteOne(`${sc}://${m2[2]}`); } catch { return whole; }
            const at = proxied.indexOf("/cyrano/");
            if (at < 0) return whole;
            for (const v of withMarks(proxied.slice(at))) alternatives.push(v);
        }
    } else if (op === "^=" && /^https?:?\/?\/?$/i.test(value)) {
        // A bare scheme prefix ("http", "https://"): every proxied URL of that scheme, marked or not.
        const scheme = sStarts(value.toLowerCase(), "https") ? ["https"] : ["http", "https"];
        for (const s of scheme) alternatives.push(`${proxyBase}/cyrano/${s}/`, `${proxyBase}/cyrano/${s}!`);
    } else {
        let proxied: string;
        try { proxied = rewriteOne(value); } catch { return whole; }
        if (proxied === value) return whole;
        for (const v of withMarks(proxied)) alternatives.push(v);
    }
    const flag = m[6] ? " " + m[6] : "";
    const test = (v: string): string => `[${name}${op}"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ")}"${flag}]`;
    return `:is(${whole},${alternatives.map(test).join(",")})`;
}

export function patchSelectors(targetWindow: Window, rewriteOne: (url: string) => string, proxyBase: string): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    const widen = (args: unknown[]): unknown[] => {
        if (!args.length || typeof args[0] !== "string") return args;
        let wide: string;
        try { wide = widenSelector(args[0], rewriteOne, proxyBase); } catch { return args; }
        return wide === args[0] ? args : [wide, ...args.slice(1)];
    };
    const wrap = (proto: object | undefined, key: string): void => {
        if (!proto || !ncall(nOP.hasOwnProperty, proto, key)) return;
        wrapMethod<(...a: unknown[]) => unknown>(proto, key, (native, self, args) => {
            const next = widen(args);
            if (next === args) return nR.apply(native, self, args);
            // A selector the native refuses is refused in the page's own words.
            try { return nR.apply(native, self, next); } catch { return nR.apply(native, self, args); }
        });
    };
    for (const name of ["Document", "DocumentFragment", "Element"]) {
        wrap(g[name]?.prototype, "querySelector");
        wrap(g[name]?.prototype, "querySelectorAll");
    }
    for (const key of ["matches", "closest", "webkitMatchesSelector"]) wrap(g["Element"]?.prototype, key);
}
