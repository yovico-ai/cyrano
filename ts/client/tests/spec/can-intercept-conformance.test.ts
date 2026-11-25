// @vitest-environment node
//
// Whether a navigation may be intercepted (src/url/can-intercept.ts)
// against spec/Route.agda canIntercept.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canIntercept } from "../../src/url/can-intercept";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const docs = ["http://127.0.0.1:8080/a/page?x", "https://a.example/p", "https://a.example:8443/p#f", "https://u:p@a.example/p", "http://a.example/"];
const targets = ["/b?y", "#h", "https://a.example/q", "https://A.EXAMPLE:443/q", "http://a.example/q", "https://b.example/", "https://a.example:8443/z",
    "https://u:p@a.example/x", "https://u@a.example/x", "//a.example/r", "http://127.0.0.1:8080/x", "http://localhost:8080/x", "http://127.0.0.1:8081/x",
    "about:blank", "?q", "../up", "https://a.example./q"];

describe.skipIf(located.skip !== "")("canIntercept: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("canIntercept is Route.canIntercept", async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom(...docs), fc.constantFrom(...targets), async (d, t) => {
            expect(canIntercept(d, t) ? "yes" : "no").toBe(await oracle.ask("canintercept", [d, t]));
        }), { numRuns: 200 });
    });
});
