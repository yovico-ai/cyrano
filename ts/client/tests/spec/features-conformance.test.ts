// @vitest-environment node
//
// Conformance of the runtime's features tokenizer (src/url/features.ts)
// with spec/Features.agda; the spec against Chromium: features-vs-chromium.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mapSources, sources } from "../../src/url/features";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

export const PIECES = ["attributionsrc", "AttributionSrc", "attributionsrcx", "noopener", "popup", "width", "=", " = ", ",", " ", "\t", "\n", "\v", "\f",
    "%2Fsrc%3Fa%3D1", "/two", "https%3A%2F%2Fads.example%2Fr", "yes", "a b", "=,", ",=", "x"];

describe.skipIf(located.skip !== "")("window.open features: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("mapSources and sources are the spec's", async () => {
        await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom(...PIECES), { maxLength: 10 }), async (ps) => {
            const f = ps.join("");
            expect(mapSources(f, (v) => `[${v}]`), JSON.stringify(f)).toBe(await oracle.ask("featuresmap", [f]));
            expect(sources(f).join("\n"), JSON.stringify(f)).toBe(await oracle.ask("featuresources", [f]));
        }), { numRuns: 500 });
    });
});
