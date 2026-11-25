// @vitest-environment node
//
// The client's SRI mark (src/url/sri.ts) against spec/Sri.agda markOf and
// honored.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sriHonored, sriMark } from "../../src/url/sri";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const tokens = ["sha256-AbC+/d=", "SHA384-xyz_-", "sha512-" + "Q".repeat(86), "sha256-", "sha1-abc", "md5-x", "sha256-a?opt", "sha384-ab=cd", "sha256-a*b",
    "sha384-" + "B".repeat(64) + "==", "nonsense", "", "sha512-a-b", "sha256-AAA="];

describe.skipIf(located.skip !== "")("Subresource Integrity: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("sriMark is Sri.markOf", async () => {
        await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom(...tokens), { maxLength: 4 }), fc.constantFrom(" ", "  ", "\t", "\n "), async (ts, sep) => {
            const md = ts.join(sep);
            expect(sriMark(md), JSON.stringify(md)).toBe(await oracle.ask("srimark", [md]));
        }), { numRuns: 300 });
    });

    it("sriHonored is Sri.honored", async () => {
        await fc.assert(fc.asyncProperty(fc.boolean(), fc.constantFrom("script", "link", "img", "iframe"), fc.constantFrom("src", "href", "xlink:href"),
            fc.array(fc.constantFrom("stylesheet", "preload", "modulepreload", "prefetch", "icon"), { maxLength: 2 }), async (svg, tag, attr, rels) => {
                const want = await oracle.ask("srihonored", [svg ? "1" : "0", tag, attr, rels.join(" ")]);
                expect(sriHonored(svg, tag, attr, rels) ? "yes" : "no").toBe(want);
            }), { numRuns: 200 });
    });
});
