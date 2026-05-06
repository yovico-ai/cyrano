// Integration sanity check for the runtime composition root.
// Asserts the $rewriter object the server-rewritten code calls into is wired
// up correctly: base-URL state, location wrapper, the various wrap_* helpers.

import { describe, expect, it } from "vitest";
import type { ClientConfig } from "../../src/config";
import { createRewriterApi } from "../../src/runtime/api";

const config: ClientConfig = {
    apiBaseURL: "http://localhost:9081",
    cacheKey: "",
    source: "/rewriter.js",
    secretCookieName: "crnsct",
    userDataEncryption: false,
    version: "0.0.1",
    rewrite_css_selectors: false,
};

describe("createRewriterApi — base URL state", () => {
    it("set_base_url updates the value get_base_url reads", () => {
        const api = createRewriterApi(window, config);
        api.set_base_url("https://example.com/foo");
        expect(api.get_base_url().href).toBe("https://example.com/foo");
    });

    it("set_location is an alias for set_base_url (no real navigation)", () => {
        const api = createRewriterApi(window, config);
        api.set_location("https://example.org/bar");
        expect(api.get_base_url().href).toBe("https://example.org/bar");
    });

    it("invalid base URLs are silently ignored, prior value preserved", () => {
        const api = createRewriterApi(window, config);
        api.set_base_url("https://example.com/initial");
        api.set_base_url("not a url");
        expect(api.get_base_url().href).toBe("https://example.com/initial");
    });
});

describe("createRewriterApi — wrap_* surface", () => {
    it("wrap_get_location returns a WrappedLocation reflecting the base URL", () => {
        const api = createRewriterApi(window, config);
        api.set_base_url("https://example.com:8443/path?q=1#frag");
        const loc = api.wrap_get_location(window.location);
        expect(loc.href).toBe("https://example.com:8443/path?q=1#frag");
        expect(loc.host).toBe("example.com:8443");
        expect(loc.pathname).toBe("/path");
    });

    it("wrap_location({obj: window}) returns the WrappedLocation when obj is the target window", () => {
        const api = createRewriterApi(window, config);
        const wrapped = api.wrap_location({ obj: window });
        expect(wrapped.location).toBeDefined();
        // Same reference as wrap_get_location returns.
        expect(wrapped.location).toBe(api.wrap_get_location(window.location));
    });

    it("wrap_location({obj: other}) wraps the location to proxify URL assignments", () => {
        const api = createRewriterApi(window, config);
        api.set_base_url("https://example.com/page");
        const realLoc = { href: "http://localhost:9081/cyrano/https/example.com/page", assign: (_u: string) => {}, replace: (_u: string) => {}, reload: () => {} } as unknown as Location;
        const fakeOther = { location: realLoc };
        const wrapped = api.wrap_location({ obj: fakeOther }).location as { href: string };
        // Must not be the raw real location object
        expect(wrapped).not.toBe(fakeOther.location);
        // Reads pass through
        expect(wrapped.href).toBe(realLoc.href);
    });

    it("wrap_top_window / wrap_parent_window forward properties", () => {
        const api = createRewriterApi(window, config);
        const top = {};
        const parent = {};
        expect(api.wrap_top_window({ obj: { top } }).top).toBe(top);
        expect(api.wrap_parent_window({ obj: { parent } }).parent).toBe(parent);
    });

    it("wrap_member_expression is passthrough; wrap_eval_memexp returns a proxy of obj", () => {
        const api = createRewriterApi(window, config);
        const obj = { a: 1 };
        expect(api.wrap_member_expression(obj, "a")).toBe(obj);
        // wrap_eval_memexp now returns a Proxy that delegates non-eval reads
        // to obj — identity changes, property access still works.
        const wrapped = api.wrap_eval_memexp(obj) as { a: number };
        expect(wrapped.a).toBe(1);
    });

    it("wrap_eval / wrap_eval_arg now route JS source through the client-side rewriter", () => {
        const api = createRewriterApi(window, config);
        // wrap_eval returns a wrapping function (not the eval identity).
        // eslint-disable-next-line no-eval
        const wrapped = api.wrap_eval(eval);
        expect(wrapped).not.toBe(eval);
        expect(typeof wrapped).toBe("function");
        // wrap_eval_arg rewrites JS source.
        // eslint-disable-next-line no-eval
        const rewritten = api.wrap_eval_arg(eval, "var x = location;");
        expect(rewritten).toContain("$rewriter.wrap_get_location(location)");
    });
});

describe("createRewriterApi — config exposure", () => {
    it("exposes the config object verbatim", () => {
        const api = createRewriterApi(window, config);
        expect(api.config).toBe(config);
    });
});

describe("createRewriterApi — wrap_import_arg", () => {
    it("proxifies an absolute string specifier through URL containment", () => {
        const api = createRewriterApi(window, config);
        api.set_base_url("https://example.com/page");
        const result = api.wrap_import_arg("https://cdn.example.com/mod.js");
        expect(typeof result).toBe("string");
        // Proxified: must contain /cyrano/ and the target host
        expect(result as string).toContain("/cyrano/");
    });

    it("proxifies a relative string specifier against the current base URL", () => {
        const api = createRewriterApi(window, config);
        api.set_base_url("https://example.com/app/");
        const result = api.wrap_import_arg("./chunk.js");
        // Resolved: https://example.com/app/chunk.js → proxified
        expect(result as string).toContain("/cyrano/");
    });

    it("passes non-string specifiers through unchanged (dynamic import with expression)", () => {
        const api = createRewriterApi(window, config);
        const expr = { notAString: true };
        expect(api.wrap_import_arg(expr)).toBe(expr);
    });

    it("passes null/undefined through unchanged", () => {
        const api = createRewriterApi(window, config);
        expect(api.wrap_import_arg(null)).toBeNull();
        expect(api.wrap_import_arg(undefined)).toBeUndefined();
    });
});
