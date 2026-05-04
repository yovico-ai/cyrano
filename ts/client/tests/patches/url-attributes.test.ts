// Runs under happy-dom. Patches the URL-bearing attribute setters/getters on
// the HTMLImageElement / HTMLAnchorElement prototypes, then restores them after
// each test to keep cross-test isolation.

import { afterEach, describe, expect, it } from "vitest";
import { patchUrlAttributes, patchAnchorUrlReflection } from "../../src/patches/url-attributes";

// Tag-suffix rewriter survives URL canonicalization (the DOM resolves attribute
// values through its URL parser, which lowercases scheme+host but preserves
// path and query verbatim).
const tag = (url: string): string =>
    url + (url.includes("?") ? "&" : "?") + "proxified=1";

// Inverse of tag — strips the proxified marker.
const untag = (url: string): string =>
    url.replace(/[?&]proxified=1/, "");

interface SavedDescriptor {
    proto: object;
    attribute: string;
    descriptor: PropertyDescriptor;
}

const savedDescriptors: SavedDescriptor[] = [];

function snapshotProperty(proto: object, attribute: string): void {
    const descriptor = Object.getOwnPropertyDescriptor(proto, attribute);
    if (!descriptor) return;
    savedDescriptors.push({ proto, attribute, descriptor });
}

afterEach(() => {
    while (savedDescriptors.length > 0) {
        const entry = savedDescriptors.pop()!;
        Object.defineProperty(entry.proto, entry.attribute, entry.descriptor);
    }
});

function snapshotAll(): void {
    snapshotProperty(HTMLImageElement.prototype, "src");
    snapshotProperty(HTMLImageElement.prototype, "srcset");
    snapshotProperty(HTMLAnchorElement.prototype, "href");
    snapshotProperty(HTMLAnchorElement.prototype, "host");
    snapshotProperty(HTMLAnchorElement.prototype, "hostname");
    snapshotProperty(HTMLAnchorElement.prototype, "port");
    snapshotProperty(HTMLAnchorElement.prototype, "protocol");
    snapshotProperty(HTMLAnchorElement.prototype, "pathname");
    snapshotProperty(HTMLAnchorElement.prototype, "search");
    snapshotProperty(HTMLAnchorElement.prototype, "hash");
    snapshotProperty(HTMLAnchorElement.prototype, "origin");
    snapshotProperty(HTMLAnchorElement.prototype, "username");
    snapshotProperty(HTMLAnchorElement.prototype, "password");
    snapshotProperty(HTMLLinkElement.prototype, "href");
    snapshotProperty(HTMLScriptElement.prototype, "src");
    snapshotProperty(HTMLIFrameElement.prototype, "src");
}

describe("patchUrlAttributes", () => {
    it("rewrites img.src on assignment (raw attribute reflects the rewritten value)", () => {
        snapshotAll();
        patchUrlAttributes(window, tag);

        const img = document.createElement("img");
        img.src = "http://example.com/a.png";
        // getAttribute returns the raw stored value, before any URL resolution.
        expect(img.getAttribute("src")).toBe("http://example.com/a.png?proxified=1");
    });

    it("rewrites img.srcset using srcset semantics (URL + descriptor)", () => {
        snapshotAll();
        patchUrlAttributes(window, tag);

        const img = document.createElement("img");
        img.srcset = "a.jpg 1x, b.jpg 2x";
        expect(img.getAttribute("srcset")).toBe("a.jpg?proxified=1 1x, b.jpg?proxified=1 2x");
    });

    it("rewrites a.href on assignment", () => {
        snapshotAll();
        patchUrlAttributes(window, tag);

        const a = document.createElement("a");
        a.href = "http://example.com/x";
        expect(a.getAttribute("href")).toBe("http://example.com/x?proxified=1");
    });

    it("rewrites script.src and iframe.src on assignment", () => {
        snapshotAll();
        patchUrlAttributes(window, tag);

        const script = document.createElement("script");
        script.src = "http://example.com/lib.js";
        expect(script.getAttribute("src")).toBe("http://example.com/lib.js?proxified=1");

        const iframe = document.createElement("iframe");
        iframe.src = "http://example.com/page";
        expect(iframe.getAttribute("src")).toBe("http://example.com/page?proxified=1");
    });

    it("passes through non-string assignments without invoking the rewriter", () => {
        const calls: unknown[] = [];
        const trackingTag = (url: string): string => {
            calls.push(url);
            return url;
        };
        snapshotAll();
        patchUrlAttributes(window, trackingTag);

        const img = document.createElement("img");
        // Setting to a non-string should not crash and should not call our
        // rewriter (which only takes strings).
        (img as unknown as { src: unknown }).src = null;
        expect(calls).toEqual([]);
    });
});

describe("patchUrlAttributes getter unwrapping", () => {
    // The getter fix is critical for webpack publicPath auto-detection.
    // Webpack reads document.currentScript.src to determine where to load
    // dynamic chunks from. Without the getter fix, it sees the proxy URL
    // (/?goto=<b64>) and computes the wrong publicPath (the proxy root),
    // causing all chunk requests to 404.

    it("script.src getter returns original URL when attribute holds a proxified URL", () => {
        snapshotAll();
        patchUrlAttributes(window, tag, untag);

        const script = document.createElement("script");
        // Simulate what the server-side HTML rewriter stored in the src attr.
        script.setAttribute("src", "http://example.com/bundle.js?proxified=1");
        expect(script.src).toBe("http://example.com/bundle.js");
    });

    it("script.src round-trip: property set then get returns original URL", () => {
        snapshotAll();
        patchUrlAttributes(window, tag, untag);

        const script = document.createElement("script");
        script.src = "http://example.com/bundle.js";
        // setter stores "…bundle.js?proxified=1", getter unwraps back to original
        expect(script.src).toBe("http://example.com/bundle.js");
    });

    it("img.src getter returns original URL", () => {
        snapshotAll();
        patchUrlAttributes(window, tag, untag);

        const img = document.createElement("img");
        img.setAttribute("src", "http://example.com/photo.jpg?proxified=1");
        expect(img.src).toBe("http://example.com/photo.jpg");
    });

    it("a.href getter returns original URL", () => {
        snapshotAll();
        patchUrlAttributes(window, tag, untag);

        const a = document.createElement("a");
        a.setAttribute("href", "http://example.com/page?proxified=1");
        expect(a.href).toBe("http://example.com/page");
    });

    it("non-proxified URLs pass through getter unchanged", () => {
        snapshotAll();
        patchUrlAttributes(window, tag, untag);

        const img = document.createElement("img");
        img.setAttribute("src", "http://example.com/photo.jpg");
        expect(img.src).toBe("http://example.com/photo.jpg");
    });

    it("srcset getter is NOT unwrapped (only single-URL attrs are unwrapped)", () => {
        snapshotAll();
        patchUrlAttributes(window, tag, untag);

        const img = document.createElement("img");
        img.setAttribute("srcset", "http://example.com/a.jpg?proxified=1 1x");
        // srcset getter returns the stored value without unwrapping
        expect(img.srcset).toContain("proxified=1");
    });
});

describe("patchAnchorUrlReflection", () => {
    // This fix addresses a class of third-party script breakage: scripts that
    // use the "anchor element as URL parser" idiom:
    //
    //   var a = document.createElement("a");
    //   a.href = upstreamUrl;   // our href setter proxifies this
    //   var host = a.host;      // BUG: returns proxy host, not upstream host
    //
    // OptinMonster (api.min.js) uses this exact pattern to detect whether it's
    // running on its primary CDN or a CNAME domain. Getting the proxy host
    // instead of the upstream CDN host causes it to set wrong base URLs for
    // CSS and API endpoints, resulting in 502s and broken styles.

    it("a.host returns upstream host after setter proxifies the href", () => {
        snapshotAll();
        // patchAnchorUrlReflection MUST be called before patchUrlAttributes
        // so it captures the native href getter.
        patchAnchorUrlReflection(untag, tag);
        patchUrlAttributes(window, tag, untag);

        const a = document.createElement("a");
        a.href = "http://example.com/path?q=1";
        // setter stored the tagged (proxified) URL; host/protocol/etc. must
        // reflect the original URL, not the stored one.
        expect(a.host).toBe("example.com");
    });

    it("a.protocol reflects upstream protocol", () => {
        snapshotAll();
        patchAnchorUrlReflection(untag, tag);
        patchUrlAttributes(window, tag, untag);

        const a = document.createElement("a");
        a.href = "https://secure.example.com/page";
        expect(a.protocol).toBe("https:");
    });

    it("a.hostname reflects upstream hostname (no port)", () => {
        snapshotAll();
        patchAnchorUrlReflection(untag, tag);
        patchUrlAttributes(window, tag, untag);

        const a = document.createElement("a");
        a.href = "https://cdn.example.com:8443/asset.js";
        expect(a.hostname).toBe("cdn.example.com");
    });

    it("a.port reflects upstream port", () => {
        snapshotAll();
        patchAnchorUrlReflection(untag, tag);
        patchUrlAttributes(window, tag, untag);

        const a = document.createElement("a");
        a.href = "https://cdn.example.com:8443/asset.js";
        expect(a.port).toBe("8443");
    });

    it("a.pathname reflects upstream pathname", () => {
        snapshotAll();
        patchAnchorUrlReflection(untag, tag);
        patchUrlAttributes(window, tag, untag);

        const a = document.createElement("a");
        a.href = "https://cdn.example.com/app/js/bundle.js";
        expect(a.pathname).toBe("/app/js/bundle.js");
    });

    it("non-proxified href: URL parts pass through unchanged", () => {
        snapshotAll();
        patchAnchorUrlReflection(untag, tag);
        patchUrlAttributes(window, tag, untag);

        const a = document.createElement("a");
        // Set a URL that the rewriter would NOT proxify (already tagged or
        // some other passthrough). Use setAttribute to bypass the setter.
        a.setAttribute("href", "http://example.com/page");
        // unwrapOne("http://example.com/page") === rawHref → fall through to native
        expect(a.host).toBe("example.com");
    });

    it("a.hostname setter updates the upstream URL and re-proxifies", () => {
        snapshotAll();
        patchAnchorUrlReflection(untag, tag);
        patchUrlAttributes(window, tag, untag);

        const a = document.createElement("a");
        a.href = "http://example.com/path?q=1";
        // href setter proxified: stored as "http://example.com/path?q=1&proxified=1"
        // hostname setter must: unwrap → mutate upstream → re-proxify
        a.hostname = "other.com";
        expect(a.hostname).toBe("other.com");
        expect(a.getAttribute("href")).toContain("proxified=1");
        expect(a.getAttribute("href")).toContain("other.com");
    });

    it("a.pathname setter updates the upstream URL and re-proxifies", () => {
        snapshotAll();
        patchAnchorUrlReflection(untag, tag);
        patchUrlAttributes(window, tag, untag);

        const a = document.createElement("a");
        a.href = "http://example.com/old-path";
        a.pathname = "/new-path";
        expect(a.pathname).toBe("/new-path");
        expect(a.getAttribute("href")).toContain("proxified=1");
        expect(a.getAttribute("href")).toContain("/new-path");
    });

    it("a.hostname setter on non-proxified href delegates to native", () => {
        snapshotAll();
        patchAnchorUrlReflection(untag, tag);
        patchUrlAttributes(window, tag, untag);

        const a = document.createElement("a");
        // setAttribute bypasses our href setter — stores the raw URL directly.
        a.setAttribute("href", "http://example.com/page");
        // hostname getter falls through (unwrapped === rawHref), so setting
        // hostname delegates to the native setter which modifies the raw href.
        a.hostname = "other.com";
        expect(a.hostname).toBe("other.com");
    });

    it("wrapping an already-proxified URL is idempotent (setter)", () => {
        snapshotAll();
        patchAnchorUrlReflection(untag, tag);
        patchUrlAttributes(window, tag, untag);

        const a = document.createElement("a");
        a.href = "http://example.com/page";
        const stored1 = a.getAttribute("href");
        // Set again — rewriteOne must not double-proxify.
        a.href = "http://example.com/page";
        expect(a.getAttribute("href")).toBe(stored1);
    });

    it("unwrapping a real (non-proxified) URL is a no-op (getter)", () => {
        snapshotAll();
        patchAnchorUrlReflection(untag, tag);
        patchUrlAttributes(window, tag, untag);

        const a = document.createElement("a");
        // Use setAttribute to store a plain URL — no proxification.
        a.setAttribute("href", "http://example.com/page");
        // getter: unwrapOne("http://example.com/page") === rawHref → native getter
        expect(a.href).toBe("http://example.com/page");
    });
});
