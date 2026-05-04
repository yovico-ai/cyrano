// @vitest-environment node
//
// post-message wrapper: dispatches on any object with a `.postMessage`
// method (Window, MessagePort, BroadcastChannel, ServiceWorker, ...).

import { describe, expect, it, vi } from "vitest";
import { wrapPostMessage } from "../../src/wrappers/post-message";

describe("wrapPostMessage — Window-like target", () => {
    it("forwards args to obj.postMessage", () => {
        const win = { postMessage: vi.fn() };
        const wrapper = wrapPostMessage({ obj: win }, "http://localhost:9081");
        wrapper.postMessage("hello", "https://example.com");
        expect(win.postMessage).toHaveBeenCalledWith("hello", "https://example.com");
    });
});

describe("wrapPostMessage — non-Window targets (MessagePort etc.)", () => {
    it("forwards args to a MessagePort-like object", () => {
        // MessagePort.postMessage(message, transfer) — different signature
        // from Window.postMessage but same name.
        const port = { postMessage: vi.fn() };
        const transfer: Transferable[] = [];
        const wrapper = wrapPostMessage({ obj: port }, "http://localhost:9081");
        wrapper.postMessage("data", transfer);
        expect(port.postMessage).toHaveBeenCalledWith("data", transfer);
    });

    it("forwards args to a BroadcastChannel-like object (single-arg)", () => {
        const channel = { postMessage: vi.fn() };
        const wrapper = wrapPostMessage({ obj: channel }, "http://localhost:9081");
        wrapper.postMessage({ type: "ping" });
        expect(channel.postMessage).toHaveBeenCalledWith({ type: "ping" });
    });
});

describe("wrapPostMessage — targetOrigin translation", () => {
    const PROXY_ORIGIN = "http://localhost:9081";

    it("translates upstream targetOrigin to proxy origin when target is a proxied window", () => {
        // Simulates: iframeWindow.postMessage(data, 'https://challenges.cloudflare.com')
        // where the iframe is proxied (location.origin === proxy origin).
        const proxiedWin = {
            postMessage: vi.fn(),
            location: { origin: PROXY_ORIGIN },
        };
        const wrapper = wrapPostMessage({ obj: proxiedWin }, PROXY_ORIGIN);
        wrapper.postMessage({ data: 1 }, "https://challenges.cloudflare.com");
        expect(proxiedWin.postMessage).toHaveBeenCalledWith({ data: 1 }, PROXY_ORIGIN);
    });

    it("translates even when location.origin returns the virtual upstream origin (WrappedLocation)", () => {
        // This is the real-world bug: window.location is patched by WrappedLocation,
        // whose .origin getter returns the virtual upstream origin
        // (e.g. 'https://www.zerohedge.com') so third-party scripts see the URL
        // they expect. The OLD check (win.location.origin === proxyOrigin) was
        // always false in this scenario. The fix: check only that location is
        // accessible (non-null), not that its .origin matches proxyOrigin.
        const proxiedWinWithVirtualOrigin = {
            postMessage: vi.fn(),
            location: { origin: "https://www.zerohedge.com" }, // WrappedLocation scenario
        };
        const wrapper = wrapPostMessage({ obj: proxiedWinWithVirtualOrigin }, PROXY_ORIGIN);
        wrapper.postMessage({ data: 1 }, "https://www.zerohedge.com");
        expect(proxiedWinWithVirtualOrigin.postMessage).toHaveBeenCalledWith({ data: 1 }, PROXY_ORIGIN);
    });

    it("leaves targetOrigin unchanged for a cross-origin window (not proxied)", () => {
        // Simulates: realExternalWindow.postMessage(data, 'https://example.com')
        // location is NOT accessible (cross-origin) — accessor throws.
        const externalWin = {
            postMessage: vi.fn(),
            get location(): { origin: string } {
                throw new DOMException("Blocked a frame with origin", "SecurityError");
            },
        };
        const wrapper = wrapPostMessage({ obj: externalWin }, PROXY_ORIGIN);
        wrapper.postMessage({ data: 2 }, "https://example.com");
        expect(externalWin.postMessage).toHaveBeenCalledWith({ data: 2 }, "https://example.com");
    });

    it("leaves '*' and '/' targetOrigins unchanged", () => {
        const win = {
            postMessage: vi.fn(),
            location: { origin: PROXY_ORIGIN },
        };
        const wrapper = wrapPostMessage({ obj: win }, PROXY_ORIGIN);
        wrapper.postMessage("msg", "*");
        expect(win.postMessage).toHaveBeenCalledWith("msg", "*");
    });
});

describe("wrapPostMessage — defensive fallbacks", () => {
    it("returns a postMessage that does nothing when obj has no method", () => {
        const wrapper = wrapPostMessage({ obj: {} }, "http://localhost:9081");
        expect(() => wrapper.postMessage("x", "*")).not.toThrow();
    });

    it("does not throw on null obj", () => {
        const wrapper = wrapPostMessage({ obj: null }, "http://localhost:9081");
        expect(() => wrapper.postMessage("x", "*")).not.toThrow();
    });
});
