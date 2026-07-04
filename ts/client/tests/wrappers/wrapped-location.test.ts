// @vitest-environment node
//
// Tests for the Location proxy that server-rewritten code reads/writes through.
//
// Key invariants:
//   - Reads return values derived from the *base URL* (the page's effective
//     original URL), not the proxified URL the browser actually loaded.
//   - Writes call assign/replace on the underlying real Location with the
//     *proxified* URL.
//   - Hash assignment is a special case: it doesn't navigate, so we update
//     the base URL state directly without proxifying.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientConfig } from "../../src/config";
import { BaseUrlState } from "../../src/runtime/base-url-state";
import { WrappedLocation } from "../../src/wrappers/wrapped-location";

const config: ClientConfig = {
    apiBaseURL: "http://localhost:9081",
    cacheKey: "",
    source: "/rewriter.js",
    secretCookieName: "crnsct",
    userDataEncryption: false,
    version: "0.0.1",
    rewrite_css_selectors: false,
};

interface FakeLocation {
    hash: string;
    assign: ReturnType<typeof vi.fn>;
    replace: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
}

function makeFakeLocation(): FakeLocation {
    return {
        hash: "",
        assign: vi.fn(),
        replace: vi.fn(),
        reload: vi.fn(),
    };
}

describe("WrappedLocation reads", () => {
    let state: BaseUrlState;
    let realLoc: FakeLocation;
    let wrapped: WrappedLocation;

    beforeEach(() => {
        state = new BaseUrlState(new URL("https://example.com:8443/foo/bar?q=1#frag"));
        realLoc = makeFakeLocation();
        wrapped = new WrappedLocation(state, realLoc as unknown as Location, config);
    });

    it("href / origin / protocol / host / hostname / port reflect the base URL", () => {
        expect(wrapped.href).toBe("https://example.com:8443/foo/bar?q=1#frag");
        expect(wrapped.origin).toBe("https://example.com:8443");
        expect(wrapped.protocol).toBe("https:");
        expect(wrapped.host).toBe("example.com:8443");
        expect(wrapped.hostname).toBe("example.com");
        expect(wrapped.port).toBe("8443");
    });

    it("pathname / search / hash reflect the base URL", () => {
        expect(wrapped.pathname).toBe("/foo/bar");
        expect(wrapped.search).toBe("?q=1");
        expect(wrapped.hash).toBe("#frag");
    });

    it("toString returns the base URL href", () => {
        expect(wrapped.toString()).toBe("https://example.com:8443/foo/bar?q=1#frag");
    });
});

describe("WrappedLocation writes route through the proxy", () => {
    let state: BaseUrlState;
    let realLoc: FakeLocation;
    let wrapped: WrappedLocation;

    beforeEach(() => {
        state = new BaseUrlState(new URL("https://example.com/"));
        realLoc = makeFakeLocation();
        wrapped = new WrappedLocation(state, realLoc as unknown as Location, config);
    });

    it("href = '...' assigns the proxified URL on the real Location", () => {
        wrapped.href = "https://example.com/foo";
        expect(realLoc.assign).toHaveBeenCalledWith(
            "http://localhost:9081/cyrano/https/example.com/foo",
        );
    });

    it("assign(url) proxifies and forwards", () => {
        wrapped.assign("/about");
        expect(realLoc.assign).toHaveBeenCalledWith(
            "http://localhost:9081/cyrano/https/example.com/about",
        );
    });

    it("replace(url) proxifies and forwards", () => {
        wrapped.replace("https://example.com/foo");
        expect(realLoc.replace).toHaveBeenCalledWith(
            "http://localhost:9081/cyrano/https/example.com/foo",
        );
    });

    it("reload() forwards directly without rewriting", () => {
        wrapped.reload();
        expect(realLoc.reload).toHaveBeenCalledTimes(1);
    });

    it("setting hash updates the base URL but does NOT navigate", () => {
        wrapped.hash = "section";
        // Real location's hash is what triggers same-document scroll/state.
        expect(realLoc.hash).toBe("section");
        // No navigation: assign/replace shouldn't fire.
        expect(realLoc.assign).not.toHaveBeenCalled();
        expect(realLoc.replace).not.toHaveBeenCalled();
        // Base URL is updated so subsequent .hash reads see the new value.
        expect(wrapped.hash).toBe("#section");
    });

    it("setting protocol/host/hostname/port/pathname/search rewrites and assigns", () => {
        wrapped.pathname = "/api/v1";
        expect(realLoc.assign).toHaveBeenCalledWith(
            "http://localhost:9081/cyrano/https/example.com/api/v1",
        );
    });
});

describe("WrappedLocation.ancestorOrigins", () => {
    // Under the proxy every frame is served from the proxy origin, so each
    // ancestor's real href is a /cyrano/<scheme>/<host>... URL that we
    // de-proxify back to its upstream origin.
    function fakeWin(href: string): Window {
        return { location: { href } } as unknown as Window;
    }

    it("returns the de-proxified upstream origins of ancestor frames", () => {
        const state = new BaseUrlState(
            new URL("https://challenges.cloudflare.com/turnstile"),
        );
        const top = fakeWin("http://localhost:9081/cyrano/https/claude.ai/");
        // top is its own parent and its own top (frame root).
        (top as unknown as { parent: Window }).parent = top;
        (top as unknown as { top: Window }).top = top;

        const child = fakeWin(
            "http://localhost:9081/cyrano/https/challenges.cloudflare.com/turnstile",
        );
        (child as unknown as { parent: Window }).parent = top;
        (child as unknown as { top: Window }).top = top;

        const wrapped = new WrappedLocation(
            state,
            makeFakeLocation() as unknown as Location,
            config,
            child,
        );

        const ao = wrapped.ancestorOrigins;
        expect(ao.length).toBe(1);
        expect(ao[0]).toBe("https://claude.ai");
        expect(ao.item(0)).toBe("https://claude.ai");
        expect(ao.item(1)).toBeNull();
        expect(ao.contains("https://claude.ai")).toBe(true);
        expect(ao.contains("https://evil.com")).toBe(false);
    });

    it("is empty for a top-level frame (no ancestors)", () => {
        const state = new BaseUrlState(new URL("https://claude.ai/"));
        const top = fakeWin("http://localhost:9081/cyrano/https/claude.ai/");
        (top as unknown as { parent: Window }).parent = top;
        (top as unknown as { top: Window }).top = top;

        const wrapped = new WrappedLocation(
            state,
            makeFakeLocation() as unknown as Location,
            config,
            top,
        );
        expect(wrapped.ancestorOrigins.length).toBe(0);
    });

    it("returns empty when no window reference is available (worker/test)", () => {
        const state = new BaseUrlState(new URL("https://claude.ai/"));
        const wrapped = new WrappedLocation(
            state,
            makeFakeLocation() as unknown as Location,
            config,
        );
        expect(wrapped.ancestorOrigins.length).toBe(0);
    });
});
