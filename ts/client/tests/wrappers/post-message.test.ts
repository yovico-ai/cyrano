// @vitest-environment node
//
// wrap_postMessage: covers rewritten scripts calling obj.postMessage(…) on
// any target window, including ad iframes that may not have the prototype
// patch applied.  targetOrigin translation happens here (translate if same-
// origin via location-readable gate; leave unchanged for cross-origin and
// for non-Window targets like MessagePort).

import { describe, expect, it, vi } from "vitest";
import { wrapPostMessage } from "../../src/wrappers/post-message";

const PROXY_ORIGIN = "http://localhost:9081";

describe("wrapPostMessage — targetOrigin translation", () => {
    it("translates upstream targetOrigin for a same-origin window", () => {
        const win = {
            postMessage: vi.fn(),
            location: { href: `${PROXY_ORIGIN}/page` },
        };
        const wrapper = wrapPostMessage({ obj: win }, PROXY_ORIGIN);
        wrapper.postMessage("hello", "https://www.zerohedge.com");
        expect(win.postMessage).toHaveBeenCalledWith("hello", PROXY_ORIGIN);
    });

    it("leaves '*' unchanged", () => {
        const win = { postMessage: vi.fn(), location: {} };
        const wrapper = wrapPostMessage({ obj: win }, PROXY_ORIGIN);
        wrapper.postMessage("msg", "*");
        expect(win.postMessage).toHaveBeenCalledWith("msg", "*");
    });

    it("leaves '/' unchanged", () => {
        const win = { postMessage: vi.fn(), location: {} };
        const wrapper = wrapPostMessage({ obj: win }, PROXY_ORIGIN);
        wrapper.postMessage("msg", "/");
        expect(win.postMessage).toHaveBeenCalledWith("msg", "/");
    });

    it("leaves targetOrigin unchanged when already the proxy origin", () => {
        const win = { postMessage: vi.fn(), location: {} };
        const wrapper = wrapPostMessage({ obj: win }, PROXY_ORIGIN);
        wrapper.postMessage("msg", PROXY_ORIGIN);
        expect(win.postMessage).toHaveBeenCalledWith("msg", PROXY_ORIGIN);
    });

    it("leaves targetOrigin unchanged for cross-origin windows (location throws)", () => {
        const crossOrigin = {
            postMessage: vi.fn(),
            get location(): unknown {
                throw new DOMException("Blocked cross-origin", "SecurityError");
            },
        };
        const wrapper = wrapPostMessage({ obj: crossOrigin }, PROXY_ORIGIN);
        wrapper.postMessage("data", "https://example.com");
        expect(crossOrigin.postMessage).toHaveBeenCalledWith("data", "https://example.com");
    });
});

describe("wrapPostMessage — non-Window targets (passthrough)", () => {
    it("forwards MessagePort-like call (message + transfer)", () => {
        const port = { postMessage: vi.fn() };
        const transfer: Transferable[] = [];
        const wrapper = wrapPostMessage({ obj: port }, PROXY_ORIGIN);
        wrapper.postMessage("data", transfer);
        expect(port.postMessage).toHaveBeenCalledWith("data", transfer);
    });

    it("forwards BroadcastChannel-like call (single arg)", () => {
        const channel = { postMessage: vi.fn() };
        const wrapper = wrapPostMessage({ obj: channel }, PROXY_ORIGIN);
        wrapper.postMessage({ type: "ping" });
        expect(channel.postMessage).toHaveBeenCalledWith({ type: "ping" });
    });
});

describe("wrapPostMessage — defensive fallbacks", () => {
    it("does nothing when obj has no postMessage method", () => {
        const wrapper = wrapPostMessage({ obj: {} }, PROXY_ORIGIN);
        expect(() => wrapper.postMessage("x", "*")).not.toThrow();
    });

    it("does not throw on null obj", () => {
        const wrapper = wrapPostMessage({ obj: null }, PROXY_ORIGIN);
        expect(() => wrapper.postMessage("x", "*")).not.toThrow();
    });
});
