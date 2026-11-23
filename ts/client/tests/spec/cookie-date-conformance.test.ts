// @vitest-environment node
//
// Conformance of src/cookies/date.ts with spec/CookieDate.agda, asked live.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cookieDate } from "../../src/cookies/date";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const PIECES = [" ", "-", ",", "/", ".", "\t", "1", "15", "31", "29", "0", "00", "2027", "27", "99", "69", "70", "1999", "12345", "123456",
    "Feb", "jun", "Sept", "OCT", "x", "Mon", "GMT", "10:11:12", "1:2:3", "23:59:60", "24:0:0", "9:9", "123:4:5", "12x", ":", "é", "😀", "+0500"];

describe.skipIf(located.skip !== "")("cookie dates: the runtime is the spec", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("reads every string as the spec does", async () => {
        const one = async (s: string): Promise<void> => {
            const want = await oracle.ask("cookiedate", [s]);
            const got = cookieDate(s);
            expect(got === null ? "none" : String(got), JSON.stringify(s)).toBe(want);
        };
        for (const s of ["Wed, 21 Oct 2026 07:28:00 GMT", "30 Feb 2027 0:0:0", "1é Jan 2027 0:0:0", "😀 Jan 2027 0:0:0", "", "1 Jan 99999 0:0:0"]) await one(s);
        await fc.assert(fc.asyncProperty(fc.array(fc.tuple(fc.constantFrom(...PIECES), fc.boolean()), { minLength: 1, maxLength: 9 }),
            async (ps) => one(ps.map(([p, sp]) => p + (sp ? " " : "")).join(""))), { numRuns: 3000 });
    });
});
