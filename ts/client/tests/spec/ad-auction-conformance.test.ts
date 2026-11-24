// @vitest-environment node
//
// Conformance of the runtime's Protected Audience answers
// (src/patches/ad-auction.ts joinAnswer) with spec/AdAuction.agda. Its
// effect in Chromium: tests/native/ad-auction-vs-chromium.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { joinAnswer } from "../../src/patches/ad-auction";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

// No percent-escapes or spaces in a host (Node's URL differs from Chromium's there).
const part = fc.constantFrom("https://", "http://", "HTTPS://", "https:", "site.example", "ads.example", ":443", ":8443", "/p", "a",
    "-", ":", "//", "?q", "#f", "wss://", "@", "u@", "SITE.example", ".", "\t");
const pages = ["https://site.example", "https://ads.example", "https://site.example:8443", "http://site.example"];

describe.skipIf(located.skip !== "")("Protected Audience: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("joinAnswer is AdAuction.joinAnswer", async () => {
        let compared = 0;
        await fc.assert(fc.asyncProperty(fc.boolean(), fc.array(part, { maxLength: 4 }), fc.constantFrom(...pages), async (complete, ps, page) => {
            const owner = ps.join("");
            const spec = await oracle.ask("adjoin", [complete ? "complete" : "missing", owner, page]);
            if (spec === "outside") return;
            compared++;
            expect(joinAnswer(complete, owner, page)).toBe(spec);
        }), { numRuns: 600 });
        expect(compared).toBeGreaterThan(300);
        expect(joinAnswer(true, "https://site.example/x", "https://site.example")).toBe("joined");
        expect(joinAnswer(true, "https://ads.example", "https://site.example")).toBe("denied");
    });
});
