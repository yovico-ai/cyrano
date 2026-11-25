// @vitest-environment node
//
// A canvas image source's origin-clean judgment (src/url/image-clean.ts)
// against spec/Canvas.agda imageClean.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { imageClean } from "../../src/url/image-clean";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const docs = ["https://a.example", "http://a.example", "https://a.example:8443", "null"];
const urls = ["https://a.example/i.png", "https://A.EXAMPLE/i.png", "https://a.example:443/i.png", "http://a.example/i.png", "https://b.example/i.png",
    "https://a.example:8443/x", "data:image/png;base64,AA", " DATA:,x", "blob:https://a.example/u", "blob:https://b.example/u", "BLOB:x",
    "file:///i.png", "ftp://a.example/i", "about:blank", "javascript:x", "\thttps://a.example/i", "https://a.example\n/i", "nonsense", "",
    "https://user:pw@a.example/i", "https://a.example./i", "https://xn--nxasmq6b.example/i", "https://a.example:80/i", "http://a.example:80/i"];

describe.skipIf(located.skip !== "")("canvas origin-clean: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("imageClean is Canvas.imageClean", async () => {
        await fc.assert(fc.asyncProperty(fc.boolean(), fc.constantFrom(...docs), fc.constantFrom(...urls), async (c, d, u) => {
            expect(imageClean(c, d, u) ? "yes" : "no").toBe(await oracle.ask("imageclean", [c ? "1" : "0", d, u]));
        }), { numRuns: 400 });
    });
});
