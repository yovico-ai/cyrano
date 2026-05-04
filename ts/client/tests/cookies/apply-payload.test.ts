// @vitest-environment node

import { beforeEach, describe, expect, it } from "vitest";
import { applyCookiePayload } from "../../src/cookies/apply-payload";
import { getCookiesForPath, clearStore } from "../../src/cookies/in-memory-store";

describe("applyCookiePayload", () => {
    beforeEach(() => {
        clearStore();
    });

    it("applies a JSON-encoded array of Set-Cookie strings", () => {
        applyCookiePayload('["k1=v1; Path=/", "k2=v2; Path=/"]', "");
        const cookies = getCookiesForPath("/");
        expect(cookies).toContain("k1=v1");
        expect(cookies).toContain("k2=v2");
    });

    it("ignores invalid JSON without throwing", () => {
        expect(() => applyCookiePayload("not json", "")).not.toThrow();
        expect(getCookiesForPath("/")).toBe("");
    });

    it("ignores non-array JSON", () => {
        applyCookiePayload('{"k": "v"}', "");
        expect(getCookiesForPath("/")).toBe("");
    });

    it("skips non-string and empty entries inside the array", () => {
        applyCookiePayload('["good=1; Path=/", null, "", 42]', "");
        expect(getCookiesForPath("/")).toContain("good=1");
    });

    it("silently drops the payload when decryption fails (non-empty secret today)", () => {
        applyCookiePayload("any-ciphertext", "non-empty-secret");
        // Decryption throws inside apply-payload's try/catch — no cookies set.
        expect(getCookiesForPath("/")).toBe("");
    });
});
