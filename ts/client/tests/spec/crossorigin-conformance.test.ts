// @vitest-environment node
//
// Conformance of the runtime's crossorigin rule (src/url/crossorigin.ts)
// with spec/Attrs.agda crossoriginValue (Go: TestSpecConformance_Crossorigin).

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { crossoriginValue } from "../../src/url/crossorigin";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

describe.skipIf(located.skip !== "")("crossorigin: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("crossoriginValue is crossoriginValue", async () => {
        await fc.assert(fc.asyncProperty(fc.boolean(), fc.constantFrom("link", "script", "img", "image", "video"),
            fc.constantFrom("", "preload", "Preload", "prefetch", "stylesheet", "modulepreload", "preload x"), fc.constantFrom("", "font", "FONT", "script", "style", "fetch", "FETCH"),
            async (html, tag, rel, as) => {
                expect(crossoriginValue(html, tag, rel, as) ?? "keep").toBe(await oracle.ask("crossorigin", [html ? "1" : "0", tag, rel, as]));
            }), { numRuns: 300 });
    });
});
