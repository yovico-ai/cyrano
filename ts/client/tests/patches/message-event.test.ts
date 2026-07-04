// @vitest-environment node
// Tests for upstreamOriginOf — the function that determines the virtual
// upstream origin of a source window for MessageEvent.origin translation.
//
// Fix 1: `source.location` reads an own-property getter installed by the location
// patch on the window instance, which returns a virtual upstream URL instead of
// the real proxy URL. unwrapProxiedUrl can't identify it as proxified.
// Primary fix: read directly from source.$rewriter.get_base_url().
// Fallback (unpatched source): call the original Window.prototype.location getter
// to get the real proxy URL, then unwrap it.
//
// Fix 2: makeWrappedHandler used `msg.source instanceof Window` to guard the
// translation path. In Chrome, same-origin cross-realm windows (e.g. an iframe
// on the same proxy origin) have constructor.name === "Window" but fail
// `instanceof Window` because each realm has its own Window constructor.
// The guard is now `msg.source != null`, relying on upstreamOriginOf's own
// null/$rewriter check to handle non-Window sources gracefully.

import { describe, expect, it } from "vitest";
import type { ClientConfig } from "../../src/config";
import { upstreamOriginOf } from "../../src/patches/message-event";

const PROXY_ORIGIN = "http://localhost:9081";

function makeConfig(): ClientConfig {
    return {
        apiBaseURL: PROXY_ORIGIN,
        cacheKey: "",
        source: "/rewriter.js",
        secretCookieName: "crnsct",
        userDataEncryption: false,
        version: "0.0.1",
        rewrite_css_selectors: false,
    };
}

describe("upstreamOriginOf — $rewriter path (primary)", () => {
    it("returns the origin from $rewriter.get_base_url()", () => {
        const config = makeConfig();
        const source = {
            $rewriter: {
                get_base_url: () => new URL("https://www.google.com/recaptcha/api2/anchor"),
            },
        } as unknown as Window;

        expect(upstreamOriginOf(source, config)).toBe("https://www.google.com");
    });

    it("returns null when $rewriter.get_base_url() returns null", () => {
        const config = makeConfig();
        const source = {
            $rewriter: { get_base_url: () => null },
        } as unknown as Window;

        expect(upstreamOriginOf(source, config)).toBeNull();
    });

    it("returns null when source has no $rewriter", () => {
        const config = makeConfig();
        const source = {} as Window;

        expect(upstreamOriginOf(source, config)).toBeNull();
    });
});

describe("upstreamOriginOf — fallback path (no $rewriter, real proxy location)", () => {
    it("unwraps the sender's real proxy location.href to the upstream origin", () => {
        const config = makeConfig();
        // A challenge-shim frame (e.g. an embedded Turnstile widget) exposes no
        // $rewriter.get_base_url; its real location IS the proxy URL. The fallback
        // reads location.href off the source window directly (NOT via the
        // Window.prototype descriptor, which is undefined because location is
        // [LegacyUnforgeable]) and unwraps it.
        const source = {
            location: { href: "http://localhost:9081/cyrano/https/challenges.cloudflare.com/turnstile/f/x" },
        } as unknown as Window;
        expect(upstreamOriginOf(source, config)).toBe("https://challenges.cloudflare.com");
    });

    it("returns null when the sender location is not a proxy URL", () => {
        const config = makeConfig();
        const source = { location: { href: "https://example.com/x" } } as unknown as Window;
        expect(upstreamOriginOf(source, config)).toBeNull();
    });

    it("returns null (no crash) when the sender has no readable location", () => {
        expect(upstreamOriginOf({} as Window, makeConfig())).toBeNull();
    });
});
