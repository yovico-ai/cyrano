// @vitest-environment node
// window.open is a navigation primitive that bypasses WrappedLocation, so it
// needs its own proxifying patch — otherwise OAuth popups (e.g. "Continue with
// Google", window.open('https://accounts.google.com/…')) escape to a raw
// hostname and the flow breaks.

import { describe, expect, it } from "vitest";
import { patchWindowOpen } from "../../src/patches/window-open";

function makeWindow() {
    const calls: Array<[unknown, unknown, unknown]> = [];
    const w = {
        open(url?: unknown, target?: unknown, features?: unknown): Window | null {
            calls.push([url, target, features]);
            return null;
        },
    } as unknown as Window;
    return { w, calls };
}

// Stand-in for install.ts's rewriteOne: turns an upstream URL into a proxied
// one, and — as rewriteUrl does — leaves other schemes as written.
const rewriteOne = (u: string): string =>
    /^https?:\/\//.test(u) ? "https://cyrano.test/cyrano/https/" + u.replace(/^https?:\/\//, "") : u;

describe("patchWindowOpen", () => {
    it("proxifies an absolute URL and preserves target + features", () => {
        const { w, calls } = makeWindow();
        patchWindowOpen(w, rewriteOne);
        w.open("https://accounts.google.com/o/oauth2/v2/auth?x=1", "_blank", "popup");
        const c = calls[0]!;
        expect(c[0]).toBe(
            "https://cyrano.test/cyrano/https/accounts.google.com/o/oauth2/v2/auth?x=1",
        );
        expect(c[1]).toBe("_blank");
        expect(c[2]).toBe("popup");
    });

    it("accepts a URL object", () => {
        const { w, calls } = makeWindow();
        patchWindowOpen(w, rewriteOne);
        w.open(new URL("https://accounts.google.com/gsi/button"));
        expect(calls[0]![0]).toBe("https://cyrano.test/cyrano/https/accounts.google.com/gsi/button");
    });

    it("passes through empty / about: / javascript: targets unchanged", () => {
        for (const u of ["", "about:blank", "javascript:void(0)"]) {
            const { w, calls } = makeWindow();
            patchWindowOpen(w, rewriteOne);
            w.open(u);
            expect(calls[0]![0]).toBe(u);
        }
    });
});
