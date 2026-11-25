// @vitest-environment node
//
// A srcdoc frame's referrer (src/url/srcdoc-referrer.ts) against
// spec/Referrer.agda srcdocReferrer.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { policyOf, srcdocReferrer } from "../../src/url/srcdoc-referrer";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

describe.skipIf(located.skip !== "")("srcdoc referrer: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("a meta's policy is Referrer.metaPolicy", async () => {
        for (const c of ["never", "NEVER", " always ", "default", "origin-when-crossorigin", "no-referrer, unsafe-url", "unsafe-url, bogus", "bogus", " origin ", "same-origin", "", "\tunsafe-url\n"]) {
            expect(policyOf(c, true) ?? "none").toBe(await oracle.ask("metapolicy", [c]));
        }
    });

    it("srcdocReferrer is Referrer.srcdocReferrer", async () => {
        for (const p of ["no-referrer", "no-referrer-when-downgrade", "same-origin", "origin", "strict-origin", "origin-when-cross-origin", "strict-origin-when-cross-origin", "unsafe-url"]) {
            for (const ref of ["http://127.0.0.1:8773/dir/page?x=1", "https://a.example/p#f", "https://u:p@a.example/q?z"]) {
                const want = await oracle.ask("srcdocreferrer", [p, ref]);
                expect(srcdocReferrer(p, ref)).toBe(want);
            }
        }
    });
});
