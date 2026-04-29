// Runs under happy-dom — uses the document.cookie API as the side-effect target.

import { beforeEach, describe, expect, it } from "vitest";
import { applyCookiePayload } from "../../src/cookies/apply-payload";

function clearAllCookies(): void {
    // happy-dom reflects each Set-Cookie by accumulating into document.cookie.
    // To clear, expire each existing one explicitly.
    const existing = document.cookie;
    if (!existing) return;
    for (const part of existing.split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        const name = part.slice(0, eq).trim();
        document.cookie = `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    }
}

describe("applyCookiePayload", () => {
    beforeEach(() => {
        clearAllCookies();
    });

    it("applies a JSON-encoded array of Set-Cookie strings", () => {
        applyCookiePayload('["k1=v1; Path=/", "k2=v2; Path=/"]', "");
        const cookies = document.cookie;
        expect(cookies).toContain("k1=v1");
        expect(cookies).toContain("k2=v2");
    });

    it("ignores invalid JSON without throwing", () => {
        const before = document.cookie;
        expect(() => applyCookiePayload("not json", "")).not.toThrow();
        expect(document.cookie).toBe(before);
    });

    it("ignores non-array JSON", () => {
        const before = document.cookie;
        applyCookiePayload('{"k": "v"}', "");
        expect(document.cookie).toBe(before);
    });

    it("skips non-string and empty entries inside the array", () => {
        applyCookiePayload('["good=1; Path=/", null, "", 42]', "");
        expect(document.cookie).toContain("good=1");
    });

    it("silently drops the payload when decryption fails (non-empty secret today)", () => {
        const before = document.cookie;
        applyCookiePayload("any-ciphertext", "non-empty-secret");
        // Decryption throws inside apply-payload's try/catch — no cookies set.
        expect(document.cookie).toBe(before);
    });
});
