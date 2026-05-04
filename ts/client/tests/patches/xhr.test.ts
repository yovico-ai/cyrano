// Runs under happy-dom — patches the XMLHttpRequest prototype, then restores
// it so other test files see a clean prototype.

import { afterEach, describe, expect, it, vi } from "vitest";
import { patchXmlHttpRequest } from "../../src/patches/xhr";

const upper = (url: string): string => url.toUpperCase();

let restoreOriginalOpen: (() => void) | null = null;

afterEach(() => {
    restoreOriginalOpen?.();
    restoreOriginalOpen = null;
});

describe("patchXmlHttpRequest", () => {
    it("rewrites the URL argument before delegating to the native open", () => {
        const proto = (globalThis as unknown as {
            XMLHttpRequest: { prototype: XMLHttpRequest };
        }).XMLHttpRequest.prototype;

        // Replace `open` with a spy *before* patching so the patcher captures
        // our spy as the "original" — then we can verify it received the
        // rewritten URL.
        const realOriginal = proto.open;
        const spy = vi.fn();
        proto.open = spy as typeof proto.open;
        restoreOriginalOpen = (): void => { proto.open = realOriginal; };

        patchXmlHttpRequest(window, upper, (u) => u);

        const xhr = new XMLHttpRequest();
        xhr.open("GET", "http://example.com/foo");
        expect(spy).toHaveBeenCalledWith(
            "GET",
            "HTTP://EXAMPLE.COM/FOO",
        );
    });

    it("accepts a URL-object argument and rewrites by href", () => {
        const proto = (globalThis as unknown as {
            XMLHttpRequest: { prototype: XMLHttpRequest };
        }).XMLHttpRequest.prototype;

        const realOriginal = proto.open;
        const spy = vi.fn();
        proto.open = spy as typeof proto.open;
        restoreOriginalOpen = (): void => { proto.open = realOriginal; };

        patchXmlHttpRequest(window, upper, (u) => u);

        const xhr = new XMLHttpRequest();
        xhr.open("POST", new URL("http://example.com/bar"));
        expect(spy.mock.calls[0]?.[1]).toBe("HTTP://EXAMPLE.COM/BAR");
    });

    it("preserves trailing arguments (async, user, password)", () => {
        const proto = (globalThis as unknown as {
            XMLHttpRequest: { prototype: XMLHttpRequest };
        }).XMLHttpRequest.prototype;

        const realOriginal = proto.open;
        const spy = vi.fn();
        proto.open = spy as typeof proto.open;
        restoreOriginalOpen = (): void => { proto.open = realOriginal; };

        patchXmlHttpRequest(window, upper, (u) => u);

        const xhr = new XMLHttpRequest();
        xhr.open("GET", "http://example.com/x", true, "user", "pass");
        expect(spy).toHaveBeenCalledWith(
            "GET",
            "HTTP://EXAMPLE.COM/X",
            true,
            "user",
            "pass",
        );
    });
});
