// @vitest-environment happy-dom
// Tests Window.prototype.postMessage patching:
// targetOrigin is translated to the proxy origin for same-origin (proxied)
// windows, and left unchanged for cross-origin windows.
//
// Test strategy: happy-dom defines postMessage as an own-property on the
// window instance, so calling window.postMessage() bypasses the prototype
// patch. We therefore:
//   1. Install a no-call-through spy on Window.prototype.postMessage BEFORE
//      calling patchPostMessage, so the patch wraps the spy as its "original".
//   2. Invoke the patched method via .call(recipient) to bypass happy-dom's
//      own-property and exercise the prototype patch directly.

import { afterEach, describe, expect, it, vi } from "vitest";
import { patchPostMessage } from "../../src/patches/post-message";

const PROXY_ORIGIN = "http://localhost:9081";

afterEach(() => {
    vi.restoreAllMocks();
});

// Invoke the patched prototype method on `recipient` with `args`.
// Bypasses happy-dom's own-property postMessage to call through the prototype.
function callPatched(recipient: object, ...args: unknown[]): void {
    (Window.prototype.postMessage as unknown as (...a: unknown[]) => void)
        .call(recipient, ...args);
}

// Install spy BEFORE patchPostMessage so the patch wraps the spy as "original".
// mockImplementation(() => {}) prevents call-through to happy-dom's native
// postMessage, which performs its own origin checks and would throw.
function setupSpy() {
    return vi.spyOn(Window.prototype, "postMessage").mockImplementation(() => {});
}

describe("patchPostMessage — targetOrigin translation", () => {
    it("translates upstream targetOrigin to proxy origin for a same-origin window", () => {
        const spy = setupSpy();
        patchPostMessage(window, PROXY_ORIGIN);

        // A recipient whose .location is readable → same-origin → translate.
        const recipient = { location: { href: `${PROXY_ORIGIN}/page` } };
        callPatched(recipient, "payload", "https://www.zerohedge.com");

        expect(spy).toHaveBeenCalledWith("payload", PROXY_ORIGIN);
    });

    it("leaves '*' targetOrigin unchanged", () => {
        const spy = setupSpy();
        patchPostMessage(window, PROXY_ORIGIN);

        const recipient = { location: { href: `${PROXY_ORIGIN}/` } };
        callPatched(recipient, "msg", "*");

        expect(spy).toHaveBeenCalledWith("msg", "*");
    });

    it("leaves '/' targetOrigin unchanged", () => {
        const spy = setupSpy();
        patchPostMessage(window, PROXY_ORIGIN);

        const recipient = { location: { href: `${PROXY_ORIGIN}/` } };
        callPatched(recipient, "msg", "/");

        expect(spy).toHaveBeenCalledWith("msg", "/");
    });

    it("leaves targetOrigin unchanged when it is already the proxy origin", () => {
        const spy = setupSpy();
        patchPostMessage(window, PROXY_ORIGIN);

        const recipient = { location: { href: `${PROXY_ORIGIN}/` } };
        callPatched(recipient, "msg", PROXY_ORIGIN);

        expect(spy).toHaveBeenCalledWith("msg", PROXY_ORIGIN);
    });

    it("leaves targetOrigin unchanged for cross-origin windows (location throws)", () => {
        const spy = setupSpy();
        patchPostMessage(window, PROXY_ORIGIN);

        // Cross-origin: reading .location throws SecurityError.
        const crossOrigin = {
            get location(): Location {
                throw new DOMException("Blocked cross-origin", "SecurityError");
            },
        };
        callPatched(crossOrigin, "data", "https://example.com");

        expect(spy).toHaveBeenCalledWith("data", "https://example.com");
    });
});
