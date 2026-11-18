// Cookies as a direct browser keeps them (spec/Cookies.agda: RFC 6265bis
// with Chromium's choices): reading a Set-Cookie string, deciding whether
// and under what scope it is stored, choosing the cookies for a URL, and
// the wire form in which a script-visible cookie lives in the browser's own
// jar on the proxy origin. Mirrors go/src/internal/urlrewrite/cookies.go.

export type SameSite = "n" | "l" | "t" | "u"; // None, Lax, Strict, default

export interface SetCookie {
    name: string;
    value: string;
    domain: string | null;  // lowercased, one leading dot removed
    path: string | null;    // only when it starts with "/"
    secure: boolean;
    httpOnly: boolean;
    sameSite: SameSite;
    maxAge: string | null;  // "-"? DIGIT+, as written
    expires: string | null; // as written
}

export interface StoredCookie {
    hostOnly: boolean;
    domain: string;
    path: string;
    name: string;
    value: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite: SameSite;
}

const trimWSP = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, "");
const lowerASCII = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const octets = (s: string): number => new TextEncoder().encode(s).length;
const cut = (s: string, sep: string): [string, string, boolean] => {
    const i = s.indexOf(sep);
    return i < 0 ? [s, "", false] : [s.slice(0, i), s.slice(i + sep.length), true];
};

/** Reads a Set-Cookie string (§5.6); null when it is ignored. */
export function parseSetCookie(s: string): SetCookie | null {
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(s)) return null;
    const parts = s.split(";");
    const [n, v, has] = cut(parts[0]!, "=");
    const c: SetCookie = {
        name: has ? trimWSP(n) : "", value: trimWSP(has ? v : n),
        domain: null, path: null, secure: false, httpOnly: false, sameSite: "u", maxAge: null, expires: null,
    };
    if (octets(c.name) + octets(c.value) > 4096) return null;
    for (const av of parts.slice(1)) {
        const [an, avv] = cut(av, "=");
        const name = lowerASCII(trimWSP(an));
        const val = trimWSP(avv);
        if (octets(val) > 1024) continue;
        switch (name) {
            case "expires": c.expires = val; break;
            // Chromium: the last Max-Age wins even when it is not a number.
            case "max-age": c.maxAge = /^(\d|-\d)\d*$/.test(val) ? val : null; break;
            case "domain": c.domain = lowerASCII(val.startsWith(".") ? val.slice(1) : val); break;
            case "path": c.path = val.startsWith("/") ? val : null; break;
            case "secure": c.secure = true; break;
            case "httponly": c.httpOnly = true; break;
            case "samesite": {
                const l = lowerASCII(val);
                c.sameSite = l === "none" ? "n" : l === "strict" ? "t" : l === "lax" ? "l" : "u";
                break;
            }
        }
    }
    return c;
}

/** Host of a URL as the spec's hostOf: no userinfo, no port, brackets kept. */
const hostOf = (u: URL): string => u.hostname;

/** "Ends in a number" (WHATWG): an IPv4 host. */
function endsInNumber(h: string): boolean {
    const parts = h.split(".");
    if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
    const last = parts[parts.length - 1] ?? "";
    return /^\d+$/.test(last) || /^0[xX][0-9a-fA-F]*$/.test(last);
}

const isIPHost = (h: string): boolean => h.startsWith("[") || endsInNumber(h);

export function domainMatch(host: string, d: string): boolean {
    return host === d || (d !== "" && host.endsWith(`.${d}`) && !isIPHost(host));
}

export function pathMatch(req: string, cp: string): boolean {
    if (req === cp) return true;
    return req.startsWith(cp) && (cp.endsWith("/") || req.charAt(cp.length) === "/");
}

function defaultPath(u: URL): string {
    const i = u.pathname.lastIndexOf("/");
    return i <= 0 ? "/" : u.pathname.slice(0, i);
}

/** Secure Contexts §3.1 for the schemes cyrano proxies (spec trustworthy). */
export function trustworthy(u: URL): boolean {
    if (u.protocol === "https:" || u.protocol === "wss:") return true;
    const h = hostOf(u);
    if (h === "localhost" || h.endsWith(".localhost") || h === "[::1]") return true;
    const p = h.split(".");
    return p.length === 4 && p[0] === "127";
}

/**
 * Whether c, set at `url` (an original URL) by a script (api) or an HTTP
 * response, is stored, and under what scope (§5.7). `publicSuffix`: the
 * Domain attribute is a public suffix (public-suffix data is outside the spec).
 */
export function storeCookie(api: boolean, publicSuffix: boolean, url: URL, c: SetCookie): StoredCookie | null {
    const prefixed = (p: string, s: string): boolean => lowerASCII(s).startsWith(p);
    const host = hostOf(url);
    let hostOnly = true;
    let domain = host;
    let domainOK = true;
    if (c.domain !== null && c.domain !== "" && !(publicSuffix && c.domain === host)) {
        hostOnly = false;
        domain = c.domain;
        domainOK = !publicSuffix && domainMatch(host, domain);
    }
    const path = c.path ?? defaultPath(url);
    if (
        (c.name === "" && c.value === "") ||
        (c.name === "" && (prefixed("__secure-", c.value) || prefixed("__host-", c.value))) ||
        (c.httpOnly && api) ||
        (c.secure && !trustworthy(url)) ||
        (c.sameSite === "n" && !c.secure) ||
        (prefixed("__secure-", c.name) && !c.secure) ||
        (prefixed("__host-", c.name) && !(c.secure && hostOnly && path === "/")) ||
        !domainOK
    ) return null;
    return { hostOnly, domain, path, name: c.name, value: c.value, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite };
}

export function matches(api: boolean, url: URL, c: StoredCookie): boolean {
    const host = hostOf(url);
    if (c.hostOnly ? host !== c.domain : !domainMatch(host, c.domain)) return false;
    return pathMatch(url.pathname, c.path) && (!c.secure || trustworthy(url)) && !(c.httpOnly && api);
}

// ── the wire form ────────────────────────────────────────────────────────

const WIRE_PREFIX = "__crn!";

/** Percent-encodes (UTF-8) every character but ALPHA, DIGIT, "." and "-". */
function esc(s: string): string {
    let out = "";
    for (const ch of s) {
        if (/^[A-Za-z0-9.-]$/.test(ch)) { out += ch; continue; }
        for (const b of new TextEncoder().encode(ch)) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    return out;
}

/** WHATWG percent-decode, byte for code point (spec pctDecode). */
const pctDecode = (s: string): string =>
    s.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

export function wireName(c: StoredCookie): string {
    return `${WIRE_PREFIX}${c.hostOnly ? "h" : "d"}!${esc(c.domain)}!${esc(c.path)}!${c.name}`;
}

export function wireValue(c: StoredCookie): string {
    return `${c.secure ? "s" : "i"}${c.sameSite}:${c.value}`;
}

/** Reads a jar entry back; null when cyrano did not write it. */
export function unwire(name: string, value: string): StoredCookie | null {
    if (!name.startsWith(WIRE_PREFIX)) return null;
    const rest = name.slice(WIRE_PREFIX.length);
    const f: string[] = [];
    let from = 0;
    for (let k = 0; k < 3; k++) {
        const i = rest.indexOf("!", from);
        if (i < 0) return null;
        f.push(rest.slice(from, i));
        from = i + 1;
    }
    f.push(rest.slice(from));
    if (f[0] !== "h" && f[0] !== "d") return null;
    if (value.length < 3 || value[2] !== ":" || !"si".includes(value[0]!) || !"nltu".includes(value[1]!)) return null;
    return {
        hostOnly: f[0] === "h", domain: pctDecode(f[1]!), path: pctDecode(f[2]!), name: f[3]!,
        value: value.slice(3), secure: value[0] === "s", httpOnly: false, sameSite: value[1] as SameSite,
    };
}

/** The cookies cyrano wrote, from the jar as the browser lists it, in its order. */
export function jarCookies(jar: string): StoredCookie[] {
    const out: StoredCookie[] = [];
    for (const p of jar.split(";")) {
        const [n, v] = cut(p.replace(/^[ \t]+/, ""), "=");
        const c = unwire(n, v);
        if (c) out.push(c);
    }
    return out;
}

/** Those for `url`: longer paths first, the given order kept among equal lengths. */
export function selectCookies(api: boolean, url: URL, cookies: StoredCookie[]): StoredCookie[] {
    const kept = cookies.filter((c) => matches(api, url, c));
    const len = (c: StoredCookie): number => [...c.path].length;
    return kept.map((c, i) => [c, i] as const).sort((a, b) => len(b[0]) - len(a[0]) || a[1] - b[1]).map(([c]) => c);
}

export function cookieString(cookies: StoredCookie[]): string {
    return cookies.map((c) => (c.name === "" ? c.value : `${c.name}=${c.value}`)).join("; ");
}

/** document.cookie (api) or a Cookie header for `url`, from the browser's jar. */
export function cookiesFor(api: boolean, url: URL, jar: string): string {
    return cookieString(selectCookies(api, url, jarCookies(jar)));
}
