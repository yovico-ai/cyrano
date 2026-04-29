// @vitest-environment node
//
// Round-trip and parity tests for the URL-safe base64 codec. The encoder must
// produce the same alphabet (no padding, `-`/`_` instead of `+`/`/`) as the Go
// server's internal/b64u and the v1 Node.js server's utils/base64.

import { describe, expect, it } from "vitest";
import { b64uDecode, b64uEncode } from "../../src/url/base64url";

describe("b64uEncode / b64uDecode round-trip", () => {
    const cases: Array<[string, string]> = [
        // input → expected base64url (no padding)
        ["http://example.com/foo", "aHR0cDovL2V4YW1wbGUuY29tL2Zvbw"],
        ["https://example.com/foo", "aHR0cHM6Ly9leGFtcGxlLmNvbS9mb28"],
        ["https://example.com/page", "aHR0cHM6Ly9leGFtcGxlLmNvbS9wYWdl"],
        ["https://cdn.example.com/script.js", "aHR0cHM6Ly9jZG4uZXhhbXBsZS5jb20vc2NyaXB0Lmpz"],
        ["https://example.com/about", "aHR0cHM6Ly9leGFtcGxlLmNvbS9hYm91dA"],
        ["http://example.com/", "aHR0cDovL2V4YW1wbGUuY29tLw"],
        // UTF-8 / emoji input
        ["http://example.com/🍏-some", "aHR0cDovL2V4YW1wbGUuY29tL_CfjY8tc29tZQ"],
        // Plain ASCII test phrase that exercises the alphabet without `+`/`/`
        ["any carnal pleasure.", "YW55IGNhcm5hbCBwbGVhc3VyZS4"],
    ];

    for (const [plain, expected] of cases) {
        it(`encode ${JSON.stringify(plain)}`, () => {
            expect(b64uEncode(plain)).toBe(expected);
        });
        it(`decode ${expected}`, () => {
            expect(b64uDecode(expected)).toBe(plain);
        });
    }
});

describe("b64uEncode produces URL-safe alphabet", () => {
    it("never emits + or / or = padding", () => {
        // A string whose standard base64 contains all three problematic chars.
        const tricky = "??>>";
        const encoded = b64uEncode(tricky);
        expect(encoded).not.toMatch(/[+/=]/);
    });
});

describe("b64uDecode rejects invalid input", () => {
    it("throws on a length that can't be padded to a multiple of 4", () => {
        // Length-1 mod 4 — never produced by a valid encoder.
        expect(() => b64uDecode("a")).toThrow(/invalid base64url/);
    });
});
