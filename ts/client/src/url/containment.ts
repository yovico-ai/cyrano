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

import { SafeSet, sStarts } from "../native/intrinsics";
import type { ClientConfig } from "../config";

// Schemes whose URLs we proxify. Anything else (data:, blob:, javascript:,
// mailto:, tel:, about:, fragment-only, etc.) passes through unchanged.
export const PROXIFIABLE_SCHEMES = new SafeSet(["http:", "https:", "ws:", "wss:"]);

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
    return isProxyOrigin(url, config) && sStarts(url.pathname, "/cyrano/");
}

/** WHATWG URL parser preprocessing (spec/Url.agda `preprocess`). */
function browserPreprocess(s: string): string {
    return s.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "").replace(/[\t\n\r]/g, "");
}

/**
 * Userinfo as the browser serializes it in href: "user:pass@", "user@",
 * ":pass@", or "" (URL.username/password are already percent-encoded).
 */
function userinfoText(u: URL): string {
    if (u.username === "" && u.password === "") return "";
    return `${u.username}${u.password === "" ? "" : `:${u.password}`}@`;
}

/**
 * Everything href holds after the authority — path, query and fragment —
 * exactly as serialized. Unlike `pathname + search + hash` it keeps a bare
 * "?" or "#": URL.search and URL.hash are "" for those, but href, which
 * page code reads, shows them.
 */
function afterAuthority(u: URL): string {
    return u.href.slice(u.protocol.length + 2 + userinfoText(u).length + u.host.length);
}

/**
 * An authority written as a path segment (spec/Containment.agda segmentOf).
 * "." and ".." are valid hosts, but as segments the browser would remove
 * them as dot segments; an empty port (".:"), which the URL parser reads
 * as no port, keeps them plain.
 */
function segmentOf(auth: string): string {
    return auth === "." || auth === ".." ? `${auth}:` : auth;
}

/**
 * Every '%' of the target's text is written %25 in the proxified path
 * (spec/Containment.agda escape), so the proxified path is always valid
 * percent-encoding — the server rejects a path whose '%' is not an escape,
 * while the origin would serve "/100%.jpg". Reading back is percent-decoding
 * (`pctDecode`), which gives the target's text exactly ("%2F" stays "%2F").
 */
function escapePct(s: string): string {
    return s.replace(/%/g, "%25");
}

/** WHATWG percent-decode (spec/Url.agda pctDecode): %XX → that byte; a stray '%' stays. */
function pctDecode(s: string): string {
    return s.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Recognizes exactly what proxify produces: /cyrano/<http|https|ws|wss>/<host><rest>
 * with a non-empty host (spec/Containment.agda `target`). The scheme segment
 * matches lowercase only, as proxify writes it; the host is taken as written.
 * Shared by remap and unwrap so the two can never disagree.
 */
function cyranoTarget(pathname: string): { scheme: string; policy: string | null; dest: Dest | null; host: string; rest: string } | null {
    const m = /^\/cyrano\/(http|https|ws|wss)((?:![^/!]*)*)\/([^/]+)(.*)$/s.exec(pathname);
    if (m === null) return null;
    // The markers (spec schemeSegment): [!<policy>][!<dest>], by their own names.
    const marks = m[2] === "" ? [] : m[2]!.slice(1).split("!");
    let policy: string | null = null, dest: Dest | null = null;
    if (marks.length === 1) {
        if (isDest(marks[0]!)) dest = marks[0] as Dest;
        else if (REFERRER_POLICIES.has(marks[0]!)) policy = marks[0]!;
        else return null;
    } else if (marks.length === 2) {
        if (!REFERRER_POLICIES.has(marks[0]!) || !isDest(marks[1]!)) return null;
        policy = marks[0]!; dest = marks[1] as Dest;
    } else if (marks.length > 2) return null;
    return { scheme: m[1]!, policy, dest, host: m[3]!, rest: m[4]! };
}

/** What a request is for, when the rewriter knows (spec Dest): a script, a stylesheet. */
// "frame": the document a frame is given by the document that holds it —
// nothing of how the response is rewritten; it tells the proxy that the
// requesting document is the frame's parent (spec Frames embedderOf).
// "inert": such a frame in which no script runs (an iframe sandboxed
// without allow-scripts: frameDest) — its document gets no runtime.
// "set": an image a srcset offers (an img's or a picture source's, a
// preload's imagesrcset): blocked as mixed content where an img's src is
// upgraded (spec MixedContent; measured).
export type Dest = "js" | "css" | "frame" | "inert" | "set";
const isDest = (t: string): boolean => t === "js" || t === "css" || t === "frame" || t === "inert" || t === "set";

/**
 * The mark of the document an iframe is given (spec Frames.frameDest):
 * "inert" when its sandbox attribute (null: absent) has no allow-scripts —
 * tokens on ASCII whitespace, compared ASCII case-insensitively.
 */
export function frameDest(sandbox: string | null): Dest {
    if (sandbox === null) return "frame";
    let token = "";
    const allows = (): boolean => token === "allow-scripts";
    for (let i = 0; i < sandbox.length; i++) {
        const c = sandbox.charCodeAt(i);
        if (c === 9 || c === 10 || c === 12 || c === 13 || c === 32) {
            if (allows()) return "frame";
            token = "";
        } else {
            token += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : sandbox[i]!;
        }
    }
    return allows() ? "frame" : "inert";
}

/** What a proxified URL's request was marked for (spec targetDest), or null. */
export function targetDest(href: string): Dest | null {
    try { return cyranoTarget(new URL(href).pathname)?.dest ?? null; } catch { return null; }
}

/** The referrer policies a scheme segment may carry (spec R.policyName). */
const REFERRER_POLICIES = new SafeSet(["no-referrer", "no-referrer-when-downgrade", "same-origin", "origin",
    "strict-origin", "origin-when-cross-origin", "strict-origin-when-cross-origin", "unsafe-url"]);

/** Whether `p` is a referrer policy's name (what a proxified URL may carry). */
export function isReferrerPolicy(p: string): boolean {
    return REFERRER_POLICIES.has(p);
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
    // The request's own referrer policy (an element's referrerpolicy,
    // fetch's referrerPolicy): carried in the scheme segment,
    // /cyrano/https!origin/… (spec rewriteUrlWith), for the proxy to apply.
    policy?: string,
    // What it is requested for, a script or a stylesheet: carried after the
    // policy, /cyrano/https!js/…, for the proxy to rewrite it as such.
    dest?: Dest,
): string {
    if (typeof rawUrl !== "string" || rawUrl.length === 0) return rawUrl;
    if (config.identity) return rawUrl;
    // In-page anchor, judged after the browser's own preprocessing (leading
    // and trailing C0/space stripped, tab/CR/LF removed) — " \x01#top" is
    // still "#top" to the browser.
    if (sStarts(browserPreprocess(rawUrl), "#")) return rawUrl;
    for (const prefix of PASSTHROUGH_PREFIXES) {
        if (sStarts(rawUrl, prefix)) return rawUrl;
    }

    // Protocol-relative URL: prefix with the page's protocol so URL parsing
    // can resolve it. Without this `new URL("//cdn/x", base)` would inherit
    // the *base*'s protocol, which is what we want, but the cleaner form lets
    // us short-circuit on parse failures uniformly below.
    let normalized = rawUrl;
    if (sStarts(normalized, "//")) {
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
    // A request to cyrano itself.
    if (isProxyOrigin(absolute, config)) return absolute.href;

    // Detect "virtual-origin + proxy-path" double-encoding: a script combined
    // the virtual window.location.origin (e.g. "https://www.google.com") with a
    // real proxy path that already carries "/cyrano/<scheme>/", producing a URL
    // like "https://www.google.com/cyrano/https/www.google.com/...".
    // Re-map to our proxy origin instead of proxifying a second time.
    if (cyranoTarget(absolute.pathname) !== null) {
        const apiBase = proxyApiBase(config);
        return `${apiBase}${afterAuthority(absolute)}`;
    }

    const apiBase = proxyApiBase(config);
    // The page cannot tell (REQUIREMENTS.md): everything href shows —
    // userinfo, a bare "?" or "#" — is carried, so unwrap gives it back.
    const scheme = absolute.protocol.slice(0, -1); // strip trailing ':'
    const rest = afterAuthority(absolute);
    const tail = rest.slice(absolute.pathname.length); // ?query#fragment, exactly
    const seg = escapePct(segmentOf(userinfoText(absolute) + absolute.host));
    const schemeSeg = scheme + (policy && REFERRER_POLICIES.has(policy) ? `!${policy}` : "") + (dest && isDest(dest) ? `!${dest}` : "");
    return `${apiBase}/cyrano/${schemeSeg}/${seg}${escapePct(absolute.pathname)}${tail}`;
}

/**
 * Unproxifies a URL: given a /cyrano/<scheme>/<host><path> URL on our proxy
 * origin, recover the original target URL. Used when page-side code reads
 * URLs back (e.g. `location.href`) and we want to hand it the URL it expects.
 *
 * Returns the input unchanged when the URL isn't on our proxy origin or
 * doesn't carry a /cyrano/ path. The rebuilt URL is read by the browser's
 * own parser, so what page code sees is what the browser would show for
 * the original (a hand-typed host segment "H.com:443" reads as "h.com").
 */
export function unwrapProxiedUrl(
    proxiedHref: string,
    config: ClientConfig,
): string {
    if (config.identity) return proxiedHref;
    let url: URL;
    try {
        url = new URL(proxiedHref);
    } catch {
        return proxiedHref;
    }
    if (!isProxyOrigin(url, config)) return proxiedHref;

    const t = cyranoTarget(url.pathname);
    if (t === null) return proxiedHref;
    const tail = afterAuthority(url).slice(url.pathname.length);
    // The host segment is read by the browser's own parser; the path is the
    // target's text, decoded segment by segment as the spec does.
    const seg = pctDecode(t.host);
    // The whole segment must be the authority: "a%2Fb" is not a host.
    if (/[/\\?#]/.test(seg)) return proxiedHref;
    let origin: URL;
    try {
        origin = new URL(`${t.scheme}://${seg}/`);
    } catch {
        return proxiedHref; // the host segment is not a host
    }
    const path = t.rest === "" ? "/" : t.rest.split("/").map(pctDecode).join("/");
    return `${t.scheme}://${userinfoText(origin)}${origin.host}${path}${tail}`;
}

/**
 * Whether a module specifier names a URL (HTML, "resolve a module
 * specifier"): it starts with "/", "./" or "../", or has a scheme. Anything
 * else is a bare specifier ("react") — resolved by the page's import map or
 * a TypeError, never a URL relative to the page — and is left as written.
 * Mirrors Go urlrewrite.IsURLLikeSpecifier.
 */
export function isUrlLikeSpecifier(s: string): boolean {
    // spec/ImportMap.agda urlLike: or an absolute URL, as the URL parser
    // reads it ("http:" alone is none; Go: urlrewrite.IsURLLikeSpecifier).
    if (sStarts(s, "/") || sStarts(s, "./") || sStarts(s, "../")) return true;
    try {
        new URL(s);
        return true;
    } catch {
        return false;
    }
}
