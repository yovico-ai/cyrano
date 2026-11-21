// Integration sanity check for the runtime composition root.
// Asserts the $rewriter object the server-rewritten code calls into is wired
// up correctly: base-URL state, location wrapper, the various wrap_* helpers.

import { unmarked } from "../../src/js/marks";
import { afterEach, describe, expect, it } from "vitest";
import type { ClientConfig } from "../../src/config";
import { createRewriterApi } from "../../src/runtime/api";

const config: ClientConfig = {
    apiBaseURL: "http://localhost:9081",
    cacheKey: "",
    source: "/rewriter.js",
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

// A fragment never reaches the server: the URL the bootstrap declares has
// none, and the document's fragment is the one the browser holds (Stripe
// passes its frames' parameters there).
describe("createRewriterApi — set_location keeps the browser's fragment", () => {
    afterEach(() => {
        window.location.hash = "";
    });

    it("a declared URL without a fragment takes location.hash", () => {
        window.location.hash = "#key=pk_test&frame=1";
        const api = createRewriterApi(window, config);
        api.set_location("https://js.stripe.example/v3/controller.html");
        expect(api.get_base_url().href).toBe("https://js.stripe.example/v3/controller.html#key=pk_test&frame=1");
        expect(api.wrap_get_location(window.location).hash).toBe("#key=pk_test&frame=1");
    });

    it("a declared URL with its own fragment keeps that one", () => {
        window.location.hash = "#browser";
        const api = createRewriterApi(window, config);
        api.set_location("https://example.org/page#declared");
        expect(api.get_base_url().href).toBe("https://example.org/page#declared");
    });

    it("no fragment in the browser: the declared URL as is", () => {
        window.location.hash = "";
        const api = createRewriterApi(window, config);
        api.set_location("https://example.org/page?q=1");
        expect(api.get_base_url().href).toBe("https://example.org/page?q=1");
    });

    it("set_base_url does not take the fragment (only the page's own declaration does)", () => {
        window.location.hash = "#browser";
        const api = createRewriterApi(window, config);
        api.set_base_url("https://example.org/page");
        expect(api.get_base_url().href).toBe("https://example.org/page");
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

    it("wrap_location of another window gives its location view (the original URL)", () => {
        const api = createRewriterApi(window, config);
        api.set_base_url("https://example.com/page");
        const realLoc = { href: "http://localhost:9081/cyrano/https/example.com/page", assign: (_u: string) => {}, replace: (_u: string) => {}, reload: () => {} } as unknown as Location;
        const other: Record<string, unknown> = { location: realLoc };
        other["window"] = other; // window-like: window.window === window
        const wrapped = api.wrap_location({ obj: other }).location as { href: string };
        expect(wrapped).not.toBe(realLoc);
        expect(wrapped.href).toBe("https://example.com/page");
    });

    it("wrap_location of any other object reads and writes its own property", () => {
        const api = createRewriterApi(window, config);
        // A router's `this.location = new URL(...)` must land on the object.
        const router: { location?: unknown } = {};
        const url = new URL("https://example.com/next");
        api.wrap_location({ obj: router }).location = url;
        expect(router.location).toBe(url);
        expect(api.wrap_location({ obj: router }).location).toBe(url);
        expect(api.wrap_location({ obj: {} }).location).toBeUndefined();
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

    it("a read of eval gives eval itself; wrap_eval_arg rewrites only for an evaluator (spec/Eval.agda)", () => {
        const api = createRewriterApi(window, config);
        // eslint-disable-next-line no-eval
        expect(api.wrap_eval(eval)).toBe(eval);
        // eslint-disable-next-line no-eval
        const rewritten = api.wrap_eval_arg(eval, "var x = location;");
        expect(unmarked(String(rewritten))).toContain("$rewriter.wrap_get_location(location)");
        // Not eval: passthrough, whatever it is called.
        const notEval = function (s: string): string { return s; };
        Object.defineProperty(notEval, "name", { value: "eval" }); // named eval, still not eval
        expect(api.wrap_eval_arg(notEval as unknown as typeof eval, "var x = location;")).toBe("var x = location;");
        // eslint-disable-next-line no-eval
        expect(api.wrap_eval_args(eval, ["var y = top;", 2])).toEqual([expect.stringContaining("wrap_get_top_window"), 2]);
        expect(api.wrap_eval_args(notEval, ["var y = top;"])).toEqual(["var y = top;"]);
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

    // import() takes the string of its specifier (ECMA-262 ToString), so
    // the wrapper does: a URL object is proxified like its href.
    it("takes the string of a non-string specifier, as import() does", () => {
        const api = createRewriterApi(window, config);
        expect(api.wrap_import_arg({ toString: () => "bare-pkg" })).toBe("bare-pkg");
        expect(api.wrap_import_arg(new URL("https://cdn.example/m.js"))).toBe(api.wrap_import_arg("https://cdn.example/m.js"));
        expect(api.wrap_import_arg(null)).toBe("null");
        expect(api.wrap_import_arg(undefined)).toBe("undefined");
    });

    it("leaves a symbol, and a toString that throws, for the native to reject", () => {
        const api = createRewriterApi(window, config);
        const sym = Symbol("s");
        expect(api.wrap_import_arg(sym)).toBe(sym);
        const err = new RangeError("nope");
        const out = api.wrap_import_arg({ toString() { throw err; } }) as { toString(): string };
        expect(() => String(out)).toThrow(err);
    });
});
