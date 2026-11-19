// @vitest-environment node
//
// Conformance of src/patches/script-kind.ts with spec/Html.agda scriptKind,
// asked live. (The document base URL is the browser's own in TS: the
// runtime reads Node.baseURI.)

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scriptKind } from "../../src/patches/script-kind";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const types = ["", " ", "text/javascript", "TEXT/JAVASCRIPT", " text/javascript ", "text/javascript; charset=utf-8",
    "application/javascript", "text/javascript1.5", "text/jscript", "text/livescript", "module", " MODULE", "Module",
    "importmap", " importmap", "speculationrules", "application/json", "x", "javascript", "text/javascript\t", "\ftext/jscript"];
const langs = ["", "javascript", "JavaScript1.5", "jscript", "vbscript", " javascript", "module", "livescript "];

describe.skipIf(located.skip !== "")("HTML: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("scriptKind", async () => {
        await fc.assert(fc.asyncProperty(fc.option(fc.constantFrom(...types), { nil: null }), fc.option(fc.constantFrom(...langs), { nil: null }),
            async (t, l) => {
                const want = await oracle.ask("scriptkind", [t !== null ? "1" : "0", t ?? "", l !== null ? "1" : "0", l ?? ""]);
                expect(scriptKind(t, l), JSON.stringify({ t, l })).toBe(want);
            }), { numRuns: 400 });
    });
});
