// Runs under happy-dom (default) so the Request constructor is available.

import { describe, expect, it, vi } from "vitest";
import { patchFetch } from "../../src/patches/fetch";

const upper = (url: string): string => url.toUpperCase();

// A rewriter that survives URL canonicalization (which lowercases scheme+host
// when a string passes through the URL/Request parser). Used in the Request
// test below where the rewritten URL is parsed before we read it back.
const tag = (url: string): string =>
    url + (url.includes("?") ? "&" : "?") + "proxified=1";

function makeFakeWindowWithFetch(): {
    win: Window;
    base: ReturnType<typeof vi.fn>;
} {
    const base = vi.fn().mockResolvedValue(new Response("ok"));
    const win = { fetch: base } as unknown as Window;
    return { win, base };
}

describe("patchFetch", () => {
    it("rewrites a string URL argument", async () => {
        const { win, base } = makeFakeWindowWithFetch();
        patchFetch(win, upper, (u) => u);

        await win.fetch("http://example.com/foo");
        expect(base).toHaveBeenCalledWith("HTTP://EXAMPLE.COM/FOO", undefined);
    });

    it("rewrites a URL object input by its href", async () => {
        const { win, base } = makeFakeWindowWithFetch();
        patchFetch(win, upper, (u) => u);

        await win.fetch(new URL("http://example.com/bar"));
        expect(base.mock.calls[0]?.[0]).toBe("HTTP://EXAMPLE.COM/BAR");
    });

    it("rewrites a Request input's URL while preserving init", async () => {
        const { win, base } = makeFakeWindowWithFetch();
        patchFetch(win, tag, (u) => u);

        const req = new Request("http://example.com/baz", { method: "POST" });
        await win.fetch(req);

        // The first arg should be a Request; we can read its url.
        const firstArg = base.mock.calls[0]?.[0] as Request;
        expect(firstArg.url).toBe("http://example.com/baz?proxified=1");
        expect(firstArg.method).toBe("POST");
    });

    it("does nothing when the window has no fetch", () => {
        const win = {} as Window;
        // No throw.
        expect(() => patchFetch(win, upper, (u) => u)).not.toThrow();
        expect(win.fetch).toBeUndefined();
    });

    it("preserves the init argument when passed", async () => {
        const { win, base } = makeFakeWindowWithFetch();
        patchFetch(win, upper, (u) => u);

        const init: RequestInit = { method: "PUT", headers: { "x-test": "1" } };
        await win.fetch("http://example.com/x", init);
        expect(base).toHaveBeenCalledWith("HTTP://EXAMPLE.COM/X", init);
    });
});
