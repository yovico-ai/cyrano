// @vitest-environment node
//
// post-message wrapper: dispatches on any object with a `.postMessage`
// method (Window, MessagePort, BroadcastChannel, ServiceWorker, ...).
// targetOrigin translation is handled by the Window.prototype patch
// (patches/post-message.ts), not here.

import { describe, expect, it, vi } from "vitest";
import { wrapPostMessage } from "../../src/wrappers/post-message";

describe("wrapPostMessage — passthrough", () => {
    it("forwards all args verbatim to obj.postMessage", () => {
        const win = { postMessage: vi.fn() };
        const wrapper = wrapPostMessage({ obj: win }, "http://localhost:9081");
        wrapper.postMessage("hello", "https://example.com");
        expect(win.postMessage).toHaveBeenCalledWith("hello", "https://example.com");
    });

    it("forwards MessagePort-like call (message + transfer)", () => {
        const port = { postMessage: vi.fn() };
        const transfer: Transferable[] = [];
        const wrapper = wrapPostMessage({ obj: port }, "http://localhost:9081");
        wrapper.postMessage("data", transfer);
        expect(port.postMessage).toHaveBeenCalledWith("data", transfer);
    });

    it("forwards BroadcastChannel-like call (single arg)", () => {
        const channel = { postMessage: vi.fn() };
        const wrapper = wrapPostMessage({ obj: channel }, "http://localhost:9081");
        wrapper.postMessage({ type: "ping" });
        expect(channel.postMessage).toHaveBeenCalledWith({ type: "ping" });
    });
});

describe("wrapPostMessage — defensive fallbacks", () => {
    it("does nothing when obj has no postMessage method", () => {
        const wrapper = wrapPostMessage({ obj: {} }, "http://localhost:9081");
        expect(() => wrapper.postMessage("x", "*")).not.toThrow();
    });

    it("does not throw on null obj", () => {
        const wrapper = wrapPostMessage({ obj: null }, "http://localhost:9081");
        expect(() => wrapper.postMessage("x", "*")).not.toThrow();
    });
});
