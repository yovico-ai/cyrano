// @vitest-environment node
//
// The runtime's readers of what the proxy carries (spec/Carry.agda), asked
// live: a Crn-H value parses to the bytes the spec writes, a crnb
// description to the sizes the spec reads (Go: proxy
// TestSpecConformance_CrnH; the spec against Chromium: carry-vs-chromium).

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { crnbRef, crnbSizes } from "../../src/patches/install";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

describe.skipIf(located.skip !== "")("Carry: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("JSON.parse of a value the spec writes is its bytes, one character each", async () => {
        const byte = fc.integer({ min: 0, max: 255 }).map((n) => String.fromCharCode(n));
        await fc.assert(fc.asyncProperty(fc.array(byte, { maxLength: 8 }).map((a) => a.join("")), async (v) => {
            const json = (await oracle.ask("jsonbytes", [v]))!;
            expect(/^[\x20-\x7e]*$/.test(json), json).toBe(true); // a header value as written: printable ASCII
            expect(JSON.parse(json)).toBe(v);
        }), { numRuns: 400 });
    });

    it("crnbSizes is crnbRead", async () => {
        const piece = fc.constantFrom("12", "0", "-", "34", "", "x", " ", "1e3", "007");
        await fc.assert(fc.asyncProperty(fc.array(piece, { maxLength: 4 }).map((a) => a.join("")), async (d) => {
            const want = (await oracle.ask("crnbread", [d]))!;
            const got = crnbSizes(d);
            expect(got === null ? "none" : `${got.encoded} ${got.decoded}`, JSON.stringify(d)).toBe(want);
        }), { numRuns: 400 });
    });

    it("crnbRef is crnbRef", async () => {
        const piece = fc.constantFrom("@", "a", "z", "0", "9", "A", "-", "12", "", " ", "é", "_");
        await fc.assert(fc.asyncProperty(fc.array(piece, { maxLength: 5 }).map((a) => a.join("")), async (d) => {
            const want = (await oracle.ask("crnbref", [d]))!;
            expect(crnbRef(d) ?? "none", JSON.stringify(d)).toBe(want);
        }), { numRuns: 400 });
    });
});
