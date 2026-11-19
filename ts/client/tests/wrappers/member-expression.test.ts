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

    it("obj['postMessage'] is the object's own (the window's is wrapped at its surface)", () => {
        const win = makeWindow();
        const api = createRewriterApi(win, cfg);
        expect(api.wrap_member_expression(win, "postMessage")).toBe(win);
    });

    // ibm.com (Akamai's sensor script keeps data under arbitrary computed
    // keys): reads returned a function that is not there, assignments were lost.
    it("write / postMessage / eval / top on an ordinary object: read, assign and typeof as written", () => {
        const api = createRewriterApi(makeWindow(), cfg);
        for (const key of ["write", "writeln", "postMessage", "eval", "top", "parent"]) {
            const obj: Record<string, unknown> = {};
            const holder = api.wrap_member_expression(obj, key) as Record<string, unknown>;
            expect(typeof holder[key], key).toBe("undefined");
            holder[key] = 7;
            expect(obj[key], key).toBe(7);
            expect((api.wrap_member_expression(obj, key) as Record<string, unknown>)[key], key).toBe(7);
        }
        const loc: Record<string, unknown> = {};
        (api.wrap_member_expression(loc, "location") as Record<string, unknown>)["location"] = "x";
        expect(loc["location"]).toBe("x");
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

// Natively `obj[key]` is one [[Get]] of key on obj. The wrapper tells
// windows and documents apart without reading the object (native/brand.ts):
// a Proxy sees exactly the access the page wrote, and nothing of the
// runtime's (Ad-Shield takes objects apart with Proxies).
describe("wrap_member_expression on a Proxy", () => {
    it("fires no trap of its own, for any special key", () => {
        const win = makeWindow();
        const api = createRewriterApi(win, cfg);
        for (const key of ["top", "parent", "location", "write", "writeln", "postMessage", "eval", "0", "x"]) {
            const seen: string[] = [];
            const target = { [key]: 1 };
            const handler = new Proxy({}, {
                get: (_h, trap: string) => (...a: unknown[]) => {
                    seen.push(`${trap} ${String(a[1])}`);
                    return (Reflect as unknown as Record<string, (...x: unknown[]) => unknown>)[trap]!(...a);
                },
            });
            const p = new Proxy(target, handler);
            const holder = api.wrap_member_expression(p, key) as Record<string, unknown>;
            // Under Node there is no browser `window` accessor to brand-check
            // with; the emulation fallback looks at the own `window` (the
            // browser path fires nothing: checked live in Chrome).
            const own = seen.filter((t) => t !== "getOwnPropertyDescriptor window");
            expect(own, key).toEqual([]);
            seen.length = 0;
            expect(holder[key], key).toBe(1);
            expect(seen, key).toEqual([`get ${key}`]);
        }
    });
    it("keeps `this` for a method named location", () => {
        const win = makeWindow();
        const api = createRewriterApi(win, cfg);
        const o = { location() { return this; } };
        expect((api.wrap_member_expression(o, "location") as typeof o).location()).toBe(o);
    });
});
