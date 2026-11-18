// Shape of the configuration object the server hands the client at injection
// time. Adding a new field requires changes on both sides — that's by design.

export interface ClientConfig {
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

    /**
     * The nonce the page's CSP asks of scripts, when it asks for one: put
     * on the bootstrap scripts the client writes itself (into
     * document.write'd documents).
     */
    nonce?: string;
}
