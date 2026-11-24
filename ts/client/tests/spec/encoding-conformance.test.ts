// @vitest-environment node
//
// Conformance of src/url/doc-query.ts with spec/Encoding.agda, asked live:
// encodeQuery with the latin1 model encoder.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encodeQuery, latin1, requery } from "../../src/url/doc-query";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

describe.skipIf(located.skip !== "")("a query in a document's encoding: the spec", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("encodeQuery is encodeQuery", async () => {
        const pieces = ["a", "q=", "é", "ü", "€", "中", " ", "\"", "#", "<", ">", "'", "&", "%", "\x01", "\x7f", "ÿ", "😀"];
        await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom(...pieces), { maxLength: 8 }), fc.boolean(), async (p, special) => {
            const q = p.join("");
            expect(encodeQuery(latin1, special, q), JSON.stringify(q)).toBe(await oracle.ask("encquery", [special ? "special" : "other", q]));
        }), { numRuns: 400 });
    });

    it("requery puts the input's query in place of the proxified URL's", () => {
        const enc = (q: string): string => encodeQuery(latin1, true, q);
        expect(requery("https://p/cyrano/https/h/a?q=%C3%A9#f", "/a?q=é#f", enc)).toBe("https://p/cyrano/https/h/a?q=%E9#f");
        expect(requery("https://p/cyrano/https/h/a?q=x", "/a?q=x", enc)).toBe("https://p/cyrano/https/h/a?q=x");
        expect(requery("https://p/cyrano/https/h/a", "/a", enc)).toBe("https://p/cyrano/https/h/a");
    });
});
