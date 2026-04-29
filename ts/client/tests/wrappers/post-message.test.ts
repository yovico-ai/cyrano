// @vitest-environment node
//
// post-message wrapper: dispatches on any object with a `.postMessage`
// method (Window, MessagePort, BroadcastChannel, ServiceWorker, ...).

import { describe, expect, it, vi } from "vitest";
import { wrapPostMessage } from "../../src/wrappers/post-message";

describe("wrapPostMessage — Window-like target", () => {
    it("forwards args to obj.postMessage", () => {
        const win = { postMessage: vi.fn() };
        const wrapper = wrapPostMessage({ obj: win });
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
        const wrapper = wrapPostMessage({ obj: port });
        wrapper.postMessage("data", transfer);
        expect(port.postMessage).toHaveBeenCalledWith("data", transfer);
    });

    it("forwards args to a BroadcastChannel-like object (single-arg)", () => {
        const channel = { postMessage: vi.fn() };
        const wrapper = wrapPostMessage({ obj: channel });
        wrapper.postMessage({ type: "ping" });
        expect(channel.postMessage).toHaveBeenCalledWith({ type: "ping" });
    });
});

describe("wrapPostMessage — defensive fallbacks", () => {
    it("returns a postMessage that does nothing when obj has no method", () => {
        const wrapper = wrapPostMessage({ obj: {} });
        expect(() => wrapper.postMessage("x", "*")).not.toThrow();
    });

    it("does not throw on null obj", () => {
        const wrapper = wrapPostMessage({ obj: null });
        expect(() => wrapper.postMessage("x", "*")).not.toThrow();
    });
});
