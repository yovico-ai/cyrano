// @vitest-environment node
//
// The document.domain setter (src/url/document-domain.ts) against
// spec/Frames.agda domainSet.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { domainSet } from "../../src/url/document-domain";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const hosts: Array<[string, boolean]> = [["www.shop.example.co.uk", false], ["a.lt.example.com", false], ["127.0.0.1", true], ["example.com", false]];
const values = ["example.co.uk", "co.uk", "shop.example.co.uk", "hop.example.co.uk", "www.shop.example.co.uk", "other.com", "lt.example.com", "example.com",
    "com", "127.0.0.1", "0.0.0.1", "", "%20example.co.uk", "example.co.uk.", "a.lt.example.com", "t.example.com"];

describe.skipIf(located.skip !== "")("document.domain setter: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("domainSet is Frames.domainSet", async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom(...hosts), fc.constantFrom(...values), fc.constantFrom("current.example", "a.lt.example.com"), fc.boolean(), fc.boolean(),
            async ([h, ip], v, cur, empty, ps) => {
                const r = domainSet(h, ip, cur, v, empty, ps);
                const got = r.kind === "set" ? "set:" + r.v : r.kind === "empty" ? "empty" : r.kind === "tld" ? "tld:" + r.v : "notsuffix:" + r.v + ":" + r.current;
                expect(got).toBe(await oracle.ask("domainset", [h, ip ? "1" : "0", cur, v, empty ? "1" : "0", ps ? "1" : "0"]));
            }), { numRuns: 300 });
    });
});
