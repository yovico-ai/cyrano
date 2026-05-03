// URL containment — the heart of the rewriter.
//
// Every URL the page would otherwise navigate to or fetch from has to be
// transformed into a request that goes through the proxy origin so that the
// proxy can intercept the response and rewrite it in turn. The transformation
// is "proxify": wrap the original target in a /cyrano/<scheme>/<host><path>
// path on the proxy origin.
//
// The inverse, "unproxify", is needed when page-side code reads URLs back
// (e.g. `location.href`) and would be confused if it saw the proxy origin.
//
// Mirrors the server's urlrewrite/rewrite.go:Rewrite. Producing byte-identical
// proxified URLs across runtimes is a hard requirement so server-rewritten
// HTML and client-side dynamic rewrites agree on the URL of every resource.

import type { ClientConfig } from "../config";

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
 * /cyrano/ path prefix). Used to avoid double-wrapping.
 */
function isAlreadyProxified(url: URL, config: ClientConfig): boolean {
    return isProxyOrigin(url, config) && url.pathname.startsWith("/cyrano/");
}

/**
 * Proxifies a URL: takes a raw URL (absolute or relative) and the page's
 * effective base URL, and returns the URL the browser should actually
 * request — i.e. a /cyrano/<scheme>/<host><path> URL on the proxy origin.
 *
 * Returns the input unchanged when:
 *   - it's empty / not a string
 *   - it's a fragment-only URL (`#anchor`)
 *   - it uses a non-proxifiable scheme (data:, javascript:, etc.)
 *   - parsing as a URL fails
 *   - the resolved URL is already proxified
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
    const scheme = absolute.protocol.slice(0, -1); // strip trailing ':'
    const cyranoPath = `/cyrano/${scheme}/${absolute.host}${absolute.pathname}`;
    return `${apiBase}${cyranoPath}${absolute.search}${absolute.hash}`;
}

/**
 * Unproxifies a URL: given a /cyrano/<scheme>/<host><path> URL on our proxy
 * origin, recover the original target URL. Used when page-side code reads
 * URLs back (e.g. `location.href`) and we want to hand it the URL it expects.
 *
 * Returns the input unchanged when the URL isn't on our proxy origin or
 * doesn't carry a /cyrano/ path.
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

    if (url.pathname.startsWith("/cyrano/")) {
        const rest = url.pathname.slice("/cyrano/".length);
        const schemeEnd = rest.indexOf("/");
        if (schemeEnd >= 0) {
            const scheme = rest.slice(0, schemeEnd);
            const afterScheme = rest.slice(schemeEnd + 1);
            const hostEnd = afterScheme.indexOf("/");
            let host: string, path: string;
            if (hostEnd < 0) {
                host = afterScheme;
                path = "/";
            } else {
                host = afterScheme.slice(0, hostEnd);
                path = afterScheme.slice(hostEnd);
            }
            if (host && (scheme === "http" || scheme === "https" || scheme === "ws" || scheme === "wss")) {
                return `${scheme}://${host}${path}${url.search}${url.hash}`;
            }
        }
    }
    return proxiedHref;
}
