// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createRewriterApi } from "../../src/runtime/api";
import type { ClientConfig } from "../../src/config";

// Minimal config sufficient to construct a RewriterApi in a non-browser env.
const cfg: ClientConfig = {
    apiBaseURL: "http://localhost:9081",
    source: "/rewriter.js",
    cacheKey: "test",
    version: "test",
    userDataEncryption: false,
    secretCookieName: "",
    rewrite_css_selectors: false,
};

// Minimal Window-like object that satisfies isWindowLike (obj.window === obj).
function makeWindow(): Window {
    const w = {} as Window;
    (w as unknown as Record<string, unknown>).window = w;
    // location stub — real WrappedLocation only cares about a few fields
    (w as unknown as Record<string, unknown>).location = {
        href: "http://localhost:9081/cyrano/https/example.com/",
        assign: () => {},
        replace: () => {},
        reload: () => {},
    } as unknown as Location;
    return w;
}

describe("wrap_member_expression", () => {
    it("obj['location'] on targetWindow returns WrappedLocation, not the real location", () => {
        const win = makeWindow();
        const api = createRewriterApi(win, cfg);
        api.set_base_url("https://example.com/page");

        const result = api.wrap_member_expression(win, "location") as { location: unknown };
        // Must return an object whose ['location'] is the WrappedLocation
        const loc = result["location"] as { href: string; origin: string };
        expect(loc.href).toBe("https://example.com/page");
        expect(loc.origin).toBe("https://example.com");
        // Must not be the raw (proxy-URL-exposing) location object
        expect(loc).not.toBe(win.location);
    });

    it("obj['location'] on a non-targetWindow wraps the location to proxify URL assignments", () => {
        const win = makeWindow();
        const api = createRewriterApi(win, cfg);
        const other = makeWindow();
        // Must return a wrapping object, not obj itself
        const result = api.wrap_member_expression(other, "location");
        expect(result).not.toBe(other);
        // The returned object's ['location'] should be a wrapper (not the raw location)
        const wrappedLoc = (result as { location: unknown }).location;
        expect(wrappedLoc).not.toBe((other as unknown as { location: unknown }).location);
    });

    it("obj['top'] delegates to wrapTopWindow — window-like passthrough", () => {
        const win = makeWindow();
        const api = createRewriterApi(win, cfg);
        // wrapTopWindow returns { top: obj.top } for window-like objects
        const result = api.wrap_member_expression(win, "top") as { top: unknown };
        expect("top" in result).toBe(true);
    });

    it("obj['parent'] delegates to wrapParentWindow", () => {
        const win = makeWindow();
        const api = createRewriterApi(win, cfg);
        const result = api.wrap_member_expression(win, "parent") as { parent: unknown };
        expect("parent" in result).toBe(true);
    });

    it("obj['postMessage'] returns a postMessage wrapper", () => {
        const win = makeWindow();
        const api = createRewriterApi(win, cfg);
        const result = api.wrap_member_expression(win, "postMessage") as { postMessage: unknown };
        expect(typeof result.postMessage).toBe("function");
    });

    it("unrelated prop is a passthrough", () => {
        const win = makeWindow();
        const api = createRewriterApi(win, cfg);
        const obj = { foo: 42 };
        expect(api.wrap_member_expression(obj, "foo")).toBe(obj);
        expect(api.wrap_member_expression(obj, Symbol("x"))).toBe(obj);
    });

    it("null/undefined do not throw", () => {
        const win = makeWindow();
        const api = createRewriterApi(win, cfg);
        expect(() => api.wrap_member_expression(null, "location")).not.toThrow();
        expect(() => api.wrap_member_expression(undefined, "top")).not.toThrow();
    });
});
