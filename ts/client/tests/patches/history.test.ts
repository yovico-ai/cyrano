// Runs under happy-dom. Tests that history.pushState / replaceState rewrite
// their URL argument before forwarding to the native History API.
//
// Strategy: replace History.prototype.{pushState,replaceState} with no-op
// spies BEFORE calling patchHistory so our patch saves the spy as `orig`.
// The spy records calls without touching real history (avoiding cross-origin
// SecurityErrors from happy-dom).

import { afterEach, describe, expect, it, vi } from "vitest";
import { patchHistory } from "../../src/patches/history";

// Rewriter that marks URLs so we can verify rewriting happened.
const proxify = (url: string): string =>
    url.startsWith("http://localhost:3000") ? url : `http://localhost:3000/?goto=${btoa(url)}`;

afterEach(() => {
    vi.restoreAllMocks();
});

describe("patchHistory — pushState", () => {
    it("rewrites an absolute URL argument", () => {
        // Spy installed BEFORE patchHistory so our patch saves it as origPushState.
        // mockImplementation(() => {}) prevents it from calling the real API (which
        // would throw a cross-origin SecurityError in happy-dom).
        const spy = vi.spyOn(History.prototype, "pushState").mockImplementation(() => {});
        patchHistory(window, proxify);

        history.pushState(null, "", "https://example.com/page");
        expect(spy).toHaveBeenCalledOnce();
        expect(spy.mock.calls[0]![2]).toBe(proxify("https://example.com/page"));
    });

    it("passes null URL through unchanged", () => {
        const spy = vi.spyOn(History.prototype, "pushState").mockImplementation(() => {});
        patchHistory(window, proxify);

        history.pushState({ x: 1 }, "", null);
        expect(spy).toHaveBeenCalledOnce();
        expect(spy.mock.calls[0]![2]).toBeNull();
    });

    it("passes undefined URL through unchanged", () => {
        const spy = vi.spyOn(History.prototype, "pushState").mockImplementation(() => {});
        patchHistory(window, proxify);

        history.pushState(null, "");
        expect(spy).toHaveBeenCalledOnce();
        expect(spy.mock.calls[0]![2]).toBeUndefined();
    });

    it("rewrites a URL object argument by its href", () => {
        const spy = vi.spyOn(History.prototype, "pushState").mockImplementation(() => {});
        patchHistory(window, proxify);

        history.pushState(null, "", new URL("https://example.com/obj"));
        expect(spy).toHaveBeenCalledOnce();
        expect(spy.mock.calls[0]![2]).toBe(proxify("https://example.com/obj"));
    });

    it("preserves already-proxied URLs untouched (no double-encode)", () => {
        const spy = vi.spyOn(History.prototype, "pushState").mockImplementation(() => {});
        patchHistory(window, proxify);

        const alreadyProxied = "http://localhost:3000/?goto=aHR0cHM6Ly9leGFtcGxlLmNvbS8";
        history.pushState(null, "", alreadyProxied);
        // proxify returns the URL unchanged when it starts with localhost:3000
        expect(spy.mock.calls[0]![2]).toBe(alreadyProxied);
    });
});

describe("patchHistory — replaceState", () => {
    it("rewrites an absolute URL argument", () => {
        const spy = vi.spyOn(History.prototype, "replaceState").mockImplementation(() => {});
        patchHistory(window, proxify);

        history.replaceState(null, "", "https://example.com/replaced");
        expect(spy).toHaveBeenCalledOnce();
        expect(spy.mock.calls[0]![2]).toBe(proxify("https://example.com/replaced"));
    });

    it("passes null URL through unchanged", () => {
        const spy = vi.spyOn(History.prototype, "replaceState").mockImplementation(() => {});
        patchHistory(window, proxify);

        history.replaceState(null, "", null);
        expect(spy).toHaveBeenCalledOnce();
        expect(spy.mock.calls[0]![2]).toBeNull();
    });
});
