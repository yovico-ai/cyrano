// @vitest-environment node
//
// The client's opener-policy rules (src/url/coop.ts) against spec/Coop.agda.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { coopEmulated, coopOf, type Coop } from "../../src/url/coop";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const values: Coop[] = ["unsafe-none", "same-origin-allow-popups", "same-origin", "same-origin-plus-coep", "noopener-allow-popups"];
const origins = ["https://a.example", "https://b.example", "https://proxy.example"];

describe.skipIf(located.skip !== "")("Cross-Origin-Opener-Policy: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("coopOf is Coop.coopFromToken", async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom("-", "same-origin", "same-origin-allow-popups", "noopener-allow-popups", "unsafe-none", "nonsense"), fc.boolean(), fc.boolean(),
            async (t, secure, corp) => {
                expect(coopOf(t === "-" ? null : t, secure, corp)).toBe(await oracle.ask("coopof", [t, secure ? "1" : "0", corp ? "1" : "0"]));
            }), { numRuns: 100 });
    });

    it("coopEmulated is Coop.emulated", async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom(...values), fc.constantFrom(...origins), fc.constantFrom(...values), fc.constantFrom(...origins),
            async (a, oa, b, ob) => {
                const want = await oracle.ask("coopemulated", [a, oa, b, ob, "https://proxy.example"]);
                expect(coopEmulated(a, oa, b, ob, "https://proxy.example") ? "yes" : "no", JSON.stringify([a, oa, b, ob])).toBe(want);
            }), { numRuns: 300 });
    });
});
