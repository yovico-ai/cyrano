import { SafeSet, SafeWeakMap, sIncludes } from "../native/intrinsics";
// Cross-origin requests, as the Fetch standard has a page see them.
//
// Under the proxy every request the browser makes is same-origin (to the
// proxy), so the browser applies none of the CORS protocol: a script would
// read every response header of another origin's response, and
// `response.type` would be "basic". Natively (Fetch §4.9 CORS check,
// §3.2.6 CORS-safelisted response-header names) a cross-origin response in
// "cors" mode
//   * fails — fetch rejects — unless Access-Control-Allow-Origin admits the
//     requesting origin (and, with credentials, names it exactly and
//     Access-Control-Allow-Credentials is "true");
//   * shows only the safelisted headers and those named by
//     Access-Control-Expose-Headers;
//   * has type "cors".
// Cloudflare's challenge lists the headers of such a response from a worker
// and reports the list.
//
// The upstream must in turn see the Origin and Sec-Fetch-Site of the
// requesting context. The proxy derives them from the Referer; where the
// request is cross-origin, or its context sends no Referer (a blob: or
// data: worker), the runtime names the context's origin in a request
// header, `Crn-I` — the URL of the context's document — and the request's
// credentials mode in `Crn-C` ("include" or "omit"); the proxy consumes
// both (Go: proxy/fetch_headers.go, proxy/storage_access.go).
//
// Not done: preflights (a request that natively needs one is sent without),
// opaque responses of "no-cors" requests, an XHR failing the CORS check.

export const INITIATOR = "Crn-I";
export const CREDENTIALS = "Crn-C";
/** The request's kind, "xhr" for an XHR (its header order: Go proxy KindHeader). */
export const KIND = "Crn-K";

const SAFELISTED = new SafeSet([
    "cache-control", "content-language", "content-length", "content-type", "expires", "last-modified", "pragma",
]);

/** Tells whether a response header (lowercase name) is shown to the script. */
export type Exposed = (name: string) => boolean;

/** Whether a request with this credentials mode carries credentials (spec/Fetch.agda includesCredentials). */
export function includesCredentials(mode: string, sameOrigin: boolean): boolean {
    return mode === "include" || (mode === "same-origin" && sameOrigin);
}

const isTchar = (c: number): boolean =>
    (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || sIncludes("!#$%&'*+-.^_`|~", String.fromCharCode(c));

/**
 * The headers a cross-origin response shows, given its
 * Access-Control-Expose-Headers as Headers.get gives it (its field lines
 * joined by ", "). As spec/Fetch.agda exposed, checked against Chromium:
 * items split on ",", trimmed of space and tab, empty ones skipped; one
 * item that is not a header name (a token) and nothing is listed. Set-Cookie
 * is never shown.
 */
export function exposedBy(exposeHeaders: string | null, credentialed: boolean): Exposed {
    const listed = new SafeSet<string>();
    let ok = true;
    for (const part of (exposeHeaders ?? "").split(",")) {
        let a = 0, b = part.length;
        while (a < b && (part.charCodeAt(a) === 0x20 || part.charCodeAt(a) === 0x09)) a++;
        while (b > a && (part.charCodeAt(b - 1) === 0x20 || part.charCodeAt(b - 1) === 0x09)) b--;
        if (a === b) continue;
        let name = "";
        for (let i = a; i < b; i++) {
            const c = part.charCodeAt(i);
            if (!isTchar(c)) { ok = false; break; }
            name += String.fromCharCode(c >= 0x41 && c <= 0x5a ? c + 32 : c);
        }
        if (!ok) break;
        listed.add(name);
    }
    if (!ok) listed.clear();
    const all = !credentialed && listed.has("*");
    return (n) => {
        const name = n.toLowerCase();
        if (name === "set-cookie" || name === "set-cookie2") return false;
        return all || SAFELISTED.has(name) || listed.has(name);
    };
}

/** The CORS check (Fetch §4.9) for a response to `origin`'s request. */
export function corsAllows(allowOrigin: string | null, allowCredentials: string | null, origin: string, credentialed: boolean): boolean {
    if (allowOrigin === null) return false;
    if (!credentialed && allowOrigin === "*") return true;
    if (allowOrigin !== origin) return false;
    return !credentialed || allowCredentials === "true";
}

/** True when `raw` (resolved against base) is an http(s) URL of another origin than `own`. */
export function isCrossOrigin(raw: string, base: URL, own: string): boolean {
    try {
        const u = new URL(raw, base);
        return (u.protocol === "http:" || u.protocol === "https:") && u.origin !== own;
    } catch {
        return false;
    }
}

/** What a realm's fetch and XHR need to know of their context. */
export interface CorsContext {
    /** The context's original origin. */
    origin: () => string;
    /** The proxy's own origin: a URL still on it (not a proxied one) is the page's own, mis-resolved. */
    proxy: string;
    /** The original URL of the context's document (a worker: of its creator). */
    href: () => string;
    /** The browser sends no Referer from this context: name the origin on every request. */
    always?: boolean;
    /** The context's own origin is opaque to the browser (a sandboxed document, a data: worker): it runs CORS itself. */
    opaque?: boolean;
}

/**
 * Whether a request names its context in Crn-I / Crn-C (spec/Fetch.agda
 * namesContext): never from an opaque context — the browser then runs the
 * protocol itself, and the headers would cause a preflight — else where it
 * crosses original origins or the context sends no Referer.
 */
export function namesContext(opaque: boolean, cross: boolean, unreferred: boolean): boolean {
    return !opaque && (cross || unreferred);
}

/** XHRs opened to another origin → the requesting origin. */
export const crossOriginXhr = new SafeWeakMap<object, string>();
/** XHRs whose request must name its context (CorsContext.always, or cross-origin) → [document URL, cross-origin]. */
export const initiatorOfXhr = new SafeWeakMap<object, { href: string; cross: boolean }>();

/** A document URL as the initiator header carries it: no fragment, no credentials. */
export function initiatorValue(href: string): string {
    try {
        const u = new URL(href);
        u.hash = "";
        u.username = "";
        u.password = "";
        return u.href;
    } catch {
        return "";
    }
}
