// @vitest-environment node
//
// javascript: URLs (src/url/js-url.ts) against spec/JsUrl.agda, with the
// oracle's stand-in for the JS rules (code naming 'x' becomes J(…)) — the
// generator of Go's TestSpecConformance_JSURL.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rewriteJsUrl } from "../../src/url/js-url";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const heads = ["javascript:", "JavaScript:", " \x01javascript:", "java\tscript:", "javascript", "jav", "http:", "\njavascript:", "JAVASCRIPT:"];
const bodies = ["x", "'<b>x</b>'", "%27x%27", "a%2", "%E2%82%AC x", "éx", "x\n y", "x y", "x%25", "x#y", "%FFx", "no", "x ", "%C3%28x", "%F0%9F%98%80x", "%00x", "x\x7f", ""];

describe.skipIf(located.skip !== "")("javascript: URLs: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("rewriteJsUrl is JsUrl.rewriteUrl", async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom(...heads), fc.constantFrom(...bodies), fc.constantFrom("", " ", "\x02"), async (h, b, t) => {
            const u = h + b + t;
            expect(rewriteJsUrl(u, (c) => (c.includes("x") ? "J(" + c + ")" : c))).toBe(await oracle.ask("jsurl", [u]));
        }), { numRuns: 400 });
    });
});
