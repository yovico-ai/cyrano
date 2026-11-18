// Tests that patchWindowLocation reports upstream origin/host for the global
// origin properties that the AST location rewriter does NOT cover:
// window.origin / self.origin and document.domain. Under the proxy these
// otherwise leak the proxy origin (localhost) to every proxied page.

import { describe, expect, it } from "vitest";
import { patchWindowLocation } from "../../src/patches/location";
import type { WrappedLocation } from "../../src/wrappers/wrapped-location";

function fakeWrappedLocation(): WrappedLocation {
    return {
        href: "https://claude.ai/foo",
        origin: "https://claude.ai",
        hostname: "claude.ai",
    } as unknown as WrappedLocation;
}

// Chromium's shapes, which happy-dom lacks: window.origin is an own
// accessor (get+set) of the window, document.domain an accessor with a
// setter on Document.prototype. The patch keeps native shapes, so it needs
// them to exist.
function chromiumShapes(): void {
    let origin = "http://localhost:9081";
    Object.defineProperty(window, "origin", { get: () => origin, set: (v: string) => { origin = v; }, configurable: true, enumerable: true });
    let domain = "localhost";
    Object.defineProperty(Object.getPrototypeOf(document) as object, "domain", { get: () => domain, set: (v: string) => { domain = v; }, configurable: true, enumerable: true });
}

describe("patchWindowLocation origin/domain wrapping", () => {
    it("window.origin and document.domain report the upstream values", () => {
        chromiumShapes();
        patchWindowLocation(window, fakeWrappedLocation(), (u) => u);
        expect(window.origin).toBe("https://claude.ai");
        expect(self.origin).toBe("https://claude.ai");
        expect(document.domain).toBe("claude.ai");
    });

    it("document.domain setter is a no-op (does not throw)", () => {
        chromiumShapes();
        patchWindowLocation(window, fakeWrappedLocation(), (u) => u);
        expect(() => { document.domain = "evil.com"; }).not.toThrow();
        expect(document.domain).toBe("claude.ai");
    });
});
