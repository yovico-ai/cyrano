// @vitest-environment node
//
// The response type a script sees (src/patches/cors.ts responseType)
// against spec/Fetch.agda responseType.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { responseType } from "../../src/patches/cors";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

describe.skipIf(located.skip !== "")("response type: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("responseType is Fetch.responseType", async () => {
        for (const mode of ["cors", "no-cors", "same-origin", "navigate"]) {
            for (const cross of [true, false]) {
                expect(responseType(mode, cross)).toBe(await oracle.ask("responsetype", [mode, cross ? "1" : "0"]));
            }
        }
    });
});
