// Shape of the configuration object the server hands the client at injection
// time. Adding a new field requires changes on both sides — that's by design.

export interface ClientConfig {
    /**
     * The WebRTC relay (Go internal/turn; spec/WebRtc.agda): the ICE servers
     * every peer connection is given in place of the page's — absent when
     * the server runs none (then a peer connection gathers nothing at all:
     * relay only, no relay).
     */
    rtc?: { urls: string[]; username: string; credential: string };
    /**
     * The single user-facing public origin for the proxy: a full URL like
     * "http://localhost:9081" or "https://proxy.example.com". This is *the*
     * canonical origin the browser sees, before any load balancer or TLS-
     * terminating frontend. Every URL the client constructs (cookies.json,
     * proxified URLs, head-injection script source) is built by appending
     * paths to this string.
     */
    apiBaseURL: string;

    /** Static-asset cache key used on `?v=…` query suffixes. */
    cacheKey: string;

    /** Path to the server-side bundle that injected this client. */
    source: string;

    /** Build version string — used in cache busting. */
    version: string;

    /** When true, rewrite URLs inside CSS selectors (e.g. `url(...)` background images). */
    rewrite_css_selectors: boolean;

    /**
     * document.referrer for this document: the Referer the server sent the
     * upstream when it requested it (natively the same value). When absent,
     * the browser's own referrer is unwrapped.
     */
    referrer?: string;
    /** The page's referrer policy as the proxy recorded it (the srcdoc frames' referrer: spec srcdocReferrer). */
    rp?: string;
    /**
     * The document's cookies, from the session's jar (spec/CookieJar.agda
     * snapshot): the jar's generation and inbox entries, name and value in
     * turn. The runtime keeps them in memory (cookies/memory.ts).
     */
    ck?: { g: number; e: string[] };

    /**
     * The nonce the page's CSP asks of scripts, when it asks for one: put
     * on the bootstrap scripts the client writes itself (into
     * document.write'd documents).
     */
    nonce?: string;

    /**
     * The page's CSP lets no inline script run: a bootstrap the runtime
     * writes itself (bootstrap-html.ts) must be external scripts only.
     */
    xb?: boolean;

    /**
     * The name of the runtime's Trusted Types policy, which the proxy added
     * to the page's `trusted-types` directive (native/trusted.ts).
     */
    tt?: string;

    /**
     * Development aid (go/src/cmd/mitmprobe): the page is on its own
     * origins — URLs are left as they are and the patches that make up for
     * every page sharing the proxy's origin are not installed. Everything
     * else (the wrappers, the rewritten scripts) is as under the proxy, so
     * a site that tells this from a native page tells by those.
     */
    identity?: boolean;

    /**
     * The portal toolbar (ui/toolbar.ts, spec/Toolbar.agda): shown over
     * top-level documents when present. `home`: the portal's main page.
     */
    toolbar?: { home: string };

    /** Development aid: names of patches (install.ts steps) not to install; "*" for all. */
    skip?: string[];
}
