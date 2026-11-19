// @vitest-environment node

// R5 `window[key]` is `wrap_member_expression(window, $__crn_key__ = key)[$__crn_key__]`.
// For a frame index, a child frame of another origin is its cross-origin
// view — the same object page code gets from the iframe's contentWindow or
// a message's source (natively one WindowProxy). For anything else the
// holder is the window itself, and the wrapper reads nothing: a getter the
// page defined on window runs exactly once, for the page's own access.

import { describe, expect, it } from "vitest";
import { createRewriterApi } from "../../src/runtime/api";
import { initCrossOrigin, isView, realWindow } from "../../src/native/cross-origin";
import type { ClientConfig } from "../../src/config";

const cfg: ClientConfig = {
    apiBaseURL: "http://localhost:9081",
    source: "/rewriter.js",
    cacheKey: "test",
    version: "test",
    rewrite_css_selectors: false,
};

// A window as the runtime recognises one under Node (native/brand.ts
// emulation: its own `window` is itself).
function fakeWindow(origin: string): Record<string, unknown> {
    const w: Record<string, unknown> = {};
    w["window"] = w;
    w["DOMException"] = DOMException;
    w["$rewriter"] = { _: { api: { get_base_url: () => new URL(origin + "/") } } };
    w["location"] = { href: "http://localhost:9081/cyrano/https/page.example/", assign: () => {}, replace: () => {}, reload: () => {} };
    return w;
}

function page() {
    const win = fakeWindow("https://page.example");
    initCrossOrigin(win as unknown as Window, () => "https://page.example", (u) => u);
    const api = createRewriterApi(win as unknown as Window, cfg);
    // What the rewritten `win[key]` reads.
    const read = (key: string | number): unknown => {
        const holder = api.wrap_member_expression(win, key) as Record<string, unknown>;
        return holder[win["$__crn_key__"] as string];
    };
    return { win, api, read };
}

describe("wrap_member_expression(window, index)", () => {
    it("a cross-origin child frame: a holder giving its view", () => {
        const { win, api, read } = page();
        const child = fakeWindow("https://ads.example");
        win["0"] = child;
        const holder = api.wrap_member_expression(win, "0");
        expect(holder === win).toBe(false);
        const got = read("0");
        expect(isView(got)).toBe(true);
        expect(realWindow(got) === child).toBe(true);
        // One view: the same object each time.
        expect(read("0") === got).toBe(true);
    });

    it("a numeric key reaches the same view", () => {
        const { win, read } = page();
        win["0"] = fakeWindow("https://ads.example");
        expect(read(0) === read("0")).toBe(true);
    });

    it("a same-origin child frame: the window itself is the holder", () => {
        const { win, api, read } = page();
        const child = fakeWindow("https://page.example");
        win["0"] = child;
        expect(api.wrap_member_expression(win, "0")).toBe(win);
        expect(read("0")).toBe(child);
    });

    it("an index with no frame, or a non-window value: the window itself", () => {
        const { win, api } = page();
        expect(api.wrap_member_expression(win, "4")).toBe(win);
        win["5"] = { not: "a window" };
        expect(api.wrap_member_expression(win, "5")).toBe(win);
    });

    it("12 is an index", () => {
        const { win, read } = page();
        win["12"] = fakeWindow("https://ads.example");
        expect(isView(read("12"))).toBe(true);
    });

    it("01, the empty string, 1a, -1, 1.5 are not indices: the window itself", () => {
        for (const key of ["01", "", "1a", "-1", "1.5", " 1", "1e1"]) {
            const { win, api } = page();
            const child = fakeWindow("https://ads.example");
            win[key] = child;
            expect(api.wrap_member_expression(win, key), JSON.stringify(key)).toBe(win);
        }
        for (const key of [-1, 1.5]) {
            const { win, api } = page();
            win[String(key)] = fakeWindow("https://ads.example");
            expect(api.wrap_member_expression(win, key), String(key)).toBe(win);
        }
    });
});

describe("wrap_member_expression(window, key): the page's getters run once", () => {
    it("a non-index key: the getter runs only for the page's own access", () => {
        const { win, api } = page();
        let runs = 0;
        Object.defineProperty(win, "adConfig", { configurable: true, get: () => { runs++; return 42; } });
        const holder = api.wrap_member_expression(win, "adConfig") as Record<string, unknown>;
        expect(runs).toBe(0);
        expect(holder).toBe(win);
        expect(holder[win["$__crn_key__"] as string]).toBe(42);
        expect(runs).toBe(1);
    });

    it("an index key with a getter: the wrapper does not run it", () => {
        const { win, api } = page();
        const child = fakeWindow("https://ads.example");
        let runs = 0;
        Object.defineProperty(win, "0", { configurable: true, get: () => { runs++; return child; } });
        const holder = api.wrap_member_expression(win, "0") as Record<string, unknown>;
        expect(runs).toBe(0);
        expect(holder).toBe(win);
        expect(holder[win["$__crn_key__"] as string]).toBe(child);
        expect(runs).toBe(1);
    });

    it("$__crn_key__ holds the key the page wrote after the call", () => {
        const { win, api } = page();
        api.wrap_member_expression(win, "0");
        expect(win["$__crn_key__"]).toBe("0");
        api.wrap_member_expression(win, "adConfig");
        expect(win["$__crn_key__"]).toBe("adConfig");
    });
});
