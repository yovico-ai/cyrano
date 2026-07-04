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

describe("patchWindowLocation origin/domain wrapping", () => {
    it("window.origin and document.domain report the upstream values", () => {
        patchWindowLocation(window, fakeWrappedLocation(), () => "");
        expect(window.origin).toBe("https://claude.ai");
        expect(self.origin).toBe("https://claude.ai");
        expect(document.domain).toBe("claude.ai");
    });

    it("document.domain setter is a no-op (does not throw)", () => {
        patchWindowLocation(window, fakeWrappedLocation(), () => "");
        expect(() => { document.domain = "evil.com"; }).not.toThrow();
        expect(document.domain).toBe("claude.ai");
    });
});
