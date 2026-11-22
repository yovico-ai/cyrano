// @vitest-environment node
//
// Conformance of the runtime's refusal of URL-based payment methods
// (src/patches/payment-request.ts refusedMethod) with spec/Payment.agda.
// Its effect in Chromium: tests/native/payment-request-vs-chromium.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { refusedMethod } from "../../src/patches/payment-request";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

// No percent-escapes or spaces in a host: refusedMethod parses with the engine's URL,
// Chromium's in a page, and Node's differs there (it refuses "https://%20",
// Chromium escapes the space: spec Url.forbiddenDomain, chromiumHost).
const part = fc.constantFrom("https://", "http://", "HTTPS://", "https:", "google.com", "/pay", "basic-card", "secure-payment-confirmation",
    "\t", "\u0000", "a", "-", ":", "//", "x.example", "?q", "#f", "ftp://", "data:,", "wss://", "[", "@");

describe.skipIf(located.skip !== "")("payment methods: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("refusedMethod is Payment.refused", async () => {
        let compared = 0;
        await fc.assert(fc.asyncProperty(fc.array(part, { maxLength: 5 }), async (ps) => {
            const id = ps.join("");
            const spec = await oracle.ask("paymentrefused", [id]);
            if (spec === "outside") return;
            compared++;
            expect(refusedMethod(id) ? "yes" : "no").toBe(spec);
        }), { numRuns: 600 });
        expect(compared).toBeGreaterThan(300);
        expect(refusedMethod("https://google.com/pay")).toBe(true);
        expect(refusedMethod("basic-card")).toBe(false);
    });
});
