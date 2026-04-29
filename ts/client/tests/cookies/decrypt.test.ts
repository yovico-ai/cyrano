// @vitest-environment node

import { describe, expect, it } from "vitest";
import { maybeDecryptCookiePayload } from "../../src/cookies/decrypt";

describe("maybeDecryptCookiePayload", () => {
    it("returns the payload unchanged when secret is empty (encryption off)", () => {
        const payload = '["k=v; Path=/"]';
        expect(maybeDecryptCookiePayload(payload, "")).toBe(payload);
    });

    it("throws when secret is non-empty (encryption-on path is unimplemented)", () => {
        // Documented TODO: AES-CTR via Web Crypto. Until that lands, this is
        // a contract: if the server sends an encrypted payload, we fail loud
        // rather than silently corrupt cookies.
        expect(() =>
            maybeDecryptCookiePayload("ciphertext", "session-secret"),
        ).toThrow(/encrypted cookie payloads not yet supported/);
    });
});
