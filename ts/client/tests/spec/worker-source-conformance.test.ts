// @vitest-environment node
//
// Conformance of the runtime's blob:/data: worker decision
// (src/patches/script-kind.ts workerRuns) with spec/WorkerSource.agda; the
// spec against Chromium: worker-source-vs-chromium.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { workerRuns } from "../../src/patches/script-kind";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

export const WORKER_TYPES = ["", "text/plain", "application/json", "text/javascript", "TEXT/JavaScript", "application/x-javascript", "text/jscript", "text/javascript1.5",
    "text/javascript; charset=utf-8", "application/ecmascript", "text/x-ecmascript", "image/png", "text/html", "foo", "text/livescript", "application/javascriptx",
    " text/javascript", "text/javascript ;x=y", "text/javascript1.6", "module", "javascript", "text/x-javascript", "application/javascript\t", "text/plain;charset=US-ASCII"];

describe.skipIf(located.skip !== "")("blob:/data: workers: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("workerRuns is runs", async () => {
        await fc.assert(fc.asyncProperty(fc.boolean(), fc.constantFrom(...WORKER_TYPES), async (module, mime) => {
            const want = await oracle.ask("workerruns", [module ? "1" : "0", mime]);
            expect(workerRuns(module, mime) ? "yes" : "no").toBe(want);
        }), { numRuns: 300 });
    });
});
