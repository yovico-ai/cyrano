// Scripts read the origin's response headers, not the proxy's changes.

import { describe, expect, it } from "vitest";
import { patchResponseHeaders } from "../../src/patches/response-headers";

describe("response headers as the origin sent them", () => {
    patchResponseHeaders(window);
    const carried = JSON.stringify({
        "content-security-policy": ["default-src 'self'"], // translated by the proxy
        "alt-svc": ['h3=":443"'],                           // neutralized
        "accept-ch": null,                                  // added by the proxy
        "content-length": ["120"],                          // the body was rewritten
    });
    const h = new Headers([
        ["content-security-policy", "default-src 'self' http://proxy"], ["alt-svc", "clear"], ["accept-ch", ""],
        ["content-length", "150"], ["content-type", "text/html"], ["crn-h", carried],
    ]);

    it("get / has", () => {
        expect(h.get("Content-Security-Policy")).toBe("default-src 'self'");
        expect(h.get("alt-svc")).toBe('h3=":443"');
        expect(h.get("content-length")).toBe("120");
        expect(h.get("content-type")).toBe("text/html");
        expect(h.has("accept-ch")).toBe(false);
        expect(h.get("accept-ch")).toBeNull();
        expect(h.has("crn-h")).toBe(false);
    });

    it("iteration", () => {
        expect([...h.keys()].sort()).toEqual( // (a browser sorts; the test DOM does not)
            ["alt-svc", "content-length", "content-security-policy", "content-type"]);
        const seen: string[] = [];
        h.forEach((v, k, self) => { seen.push(k + "=" + v); expect(self).toBe(h); });
        expect(seen).toContain("content-length=120");
        expect(Object.fromEntries(h)).not.toHaveProperty("crn-h");
    });

    it("headers nothing was changed in are untouched", () => {
        const plain = new Headers([["x-a", "1"]]);
        expect([...plain]).toEqual([["x-a", "1"]]);
    });
});
