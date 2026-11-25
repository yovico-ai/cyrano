// @vitest-environment node
//
// window.originAgentCluster's rule (src/patches/oac.ts) against spec/Oac.agda.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { oacReads } from "../../src/patches/oac";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

describe.skipIf(located.skip !== "")("originAgentCluster: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("oacReads is Oac.reads", async () => {
        for (const r of [undefined, true, false]) for (const sc of [true, false]) for (const h of [undefined, "?0", "?1", "bogus", ""]) {
            const want = await oracle.ask("oacreads", [r === undefined ? "-" : String(r), sc ? "1" : "0", h === undefined ? "-" : h]);
            expect(String(oacReads(r, sc, h)), JSON.stringify([r, sc, h])).toBe(want);
        }
    });
});
