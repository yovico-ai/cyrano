// URL containment — the heart of the rewriter.
//
// Every URL the page would otherwise navigate to or fetch from has to be
// transformed into a request that goes through the proxy origin so that the
// proxy can intercept the response and rewrite it in turn. The transformation
// is "proxify": wrap the original target in a base64url-encoded `?goto=...`
// query parameter on the proxy origin.
//
// The inverse, "unproxify", is needed when page-side code reads URLs back
// (e.g. `location.href`) and would be confused if it saw the proxy origin.
//
// Mirrors the server's utils/url.js:getRewrittenUrl. Some optimizations the
// server applies are intentionally omitted from the client first cut — they
// are listed inline below and will be revisited.

import type { ClientConfig } from "../config";
import { b64uDecode, b64uEncode } from "./base64url";

// Schemes whose URLs we proxify. Anything else (data:, blob:, javascript:,
// mailto:, tel:, about:, fragment-only, etc.) passes through unchanged.
const PROXIFIABLE_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

// Schemes we must explicitly NOT touch — passed through verbatim. Listed for
// clarity; the proxifiable check above already filters them out implicitly.
const PASSTHROUGH_PREFIXES = [
    "javascript:",
    "data:",
    "blob:",
    "mailto:",
    "tel:",
    "about:",
];

/**
 * Returns the single user-facing public origin (scheme://host[:port]) the
 * page-side code is supposed to talk to. Just config.apiBaseURL — there's
 * exactly one proxy origin regardless of the target's scheme.
 */
export function proxyApiBase(config: ClientConfig): string {
    return config.apiBaseURL;
}

/** True if the given URL points at our public proxy origin. */
function isProxyOrigin(url: URL, config: ClientConfig): boolean {
    let publicOrigin: URL;
    try {
        publicOrigin = new URL(config.apiBaseURL);
    } catch {
        return false;
    }
    if (url.protocol !== publicOrigin.protocol) return false;
    return effectiveHost(url) === effectiveHost(publicOrigin);
}

/** Host:port with default ports made explicit so explicit and implicit forms compare equal. */
function effectiveHost(u: URL): string {
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return `${u.hostname}:${port}`;
}

/**
 * True if this URL is already a proxified URL on our origin (i.e. has the
 * `?goto=...` parameter). Used to avoid double-wrapping.
 */
function isAlreadyProxified(url: URL, config: ClientConfig): boolean {
    return isProxyOrigin(url, config) && url.searchParams.has("goto");
}

/**
 * Proxifies a URL: takes a raw URL (absolute or relative) and the page's
 * effective base URL, and returns the URL the browser should actually
 * request — i.e. a `?goto=<base64url(target)>` URL on the proxy origin.
 *
 * Returns the input unchanged when:
 *   - it's empty / not a string
 *   - it's a fragment-only URL (`#anchor`)
 *   - it uses a non-proxifiable scheme (data:, javascript:, etc.)
 *   - parsing as a URL fails
 *   - the resolved URL is already proxified
 *
 * First-cut omissions vs the server (intentional, will revisit):
 *   - No URL-length compression (server uses pako above 5000 chars)
 *   - No cache-busting `v=cacheKey` query suffix
 *   - Always emits the `?goto=...` query form, never the `/load/<b64>/` REST form
 */
export function rewriteUrl(
    rawUrl: string,
    pageBaseUrl: URL,
    config: ClientConfig,
): string {
    if (typeof rawUrl !== "string" || rawUrl.length === 0) return rawUrl;
    if (rawUrl.startsWith("#")) return rawUrl;
    for (const prefix of PASSTHROUGH_PREFIXES) {
        if (rawUrl.startsWith(prefix)) return rawUrl;
    }

    // Protocol-relative URL: prefix with the page's protocol so URL parsing
    // can resolve it. Without this `new URL("//cdn/x", base)` would inherit
    // the *base*'s protocol, which is what we want, but the cleaner form lets
    // us short-circuit on parse failures uniformly below.
    let normalized = rawUrl;
    if (normalized.startsWith("//")) {
        normalized = pageBaseUrl.protocol + normalized;
    }

    let absolute: URL;
    try {
        absolute = new URL(normalized, pageBaseUrl);
    } catch {
        return rawUrl;
    }

    if (!PROXIFIABLE_SCHEMES.has(absolute.protocol)) return rawUrl;
    if (isAlreadyProxified(absolute, config)) return rawUrl;
    if (isProxyOrigin(absolute, config)) return absolute.href;

    const apiBase = proxyApiBase(config);
    // The fragment never participates in HTTP requests, so we keep it on the
    // proxified URL itself rather than encoding it inside `goto=`. This way
    // browser-native fragment navigation behaves correctly.
    const targetWithoutFragment =
        `${absolute.protocol}//${absolute.host}${absolute.pathname}${absolute.search}`;
    return `${apiBase}/?goto=${b64uEncode(targetWithoutFragment)}${absolute.hash}`;
}

/**
 * Unproxifies a URL: given a `?goto=<b64>...` URL on our proxy origin, recover
 * the original target URL. Used when page-side code reads URLs back (e.g.
 * `location.href`) and we want to hand it the URL it expects.
 *
 * Returns the input unchanged when the URL isn't on our proxy origin or
 * doesn't carry a `goto=` parameter.
 */
export function unwrapProxiedUrl(
    proxiedHref: string,
    config: ClientConfig,
): string {
    let url: URL;
    try {
        url = new URL(proxiedHref);
    } catch {
        return proxiedHref;
    }
    if (!isProxyOrigin(url, config)) return proxiedHref;

    const gotoParam = url.searchParams.get("goto");
    if (gotoParam) {
        try {
            return b64uDecode(gotoParam) + url.hash;
        } catch {
            return proxiedHref;
        }
    }
    return proxiedHref;
}
