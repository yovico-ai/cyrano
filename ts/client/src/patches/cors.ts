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

const SAFELISTED = new Set([
    "cache-control", "content-language", "content-length", "content-type", "expires", "last-modified", "pragma",
]);

/** Tells whether a response header (lowercase name) is shown to the script. */
export type Exposed = (name: string) => boolean;

/** The headers a cross-origin response shows, given its Access-Control-Expose-Headers. */
export function exposedBy(exposeHeaders: string | null, credentialed: boolean): Exposed {
    const listed = new Set<string>();
    let all = false;
    for (const part of (exposeHeaders ?? "").split(",")) {
        const name = part.trim().toLowerCase();
        if (name === "*" && !credentialed) all = true;
        else if (name) listed.add(name);
    }
    if (all) return (n) => n !== "set-cookie" && n !== "set-cookie2";
    return (n) => SAFELISTED.has(n) || listed.has(n);
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
    /** The original URL of the context's document (a worker: of its creator). */
    href: () => string;
    /** The browser sends no Referer from this context: name the origin on every request. */
    always?: boolean;
}

/** XHRs opened to another origin → the requesting origin. */
export const crossOriginXhr = new WeakMap<object, string>();
/** XHRs whose request must name its context (CorsContext.always, or cross-origin) → [document URL, cross-origin]. */
export const initiatorOfXhr = new WeakMap<object, { href: string; cross: boolean }>();

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
