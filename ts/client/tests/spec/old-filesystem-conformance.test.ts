// @vitest-environment node
//
// The old FileSystem API's paths under a storage key
// (src/patches/old-filesystem.ts fsPath, shownPath) against spec/Storage.agda.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fsPath, shownPath } from "../../src/patches/old-filesystem";
import { opfsDirName } from "../../src/patches/storage";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const keys = ["https://a.example", "https://a.example^https://b.example", "x%2/\\y"];
const ats = ["/", "/d", "/d/e", "", "d", "/d/"];
const givens = ["x", "/x", "../x", "../../x", "/../x", "d/../q", "./a//b/", "", "/", "..", ".", "a/./../b", "..x/.y", "/a/b/../../.."];

describe.skipIf(located.skip !== "")("old FileSystem API paths: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("fsPath is Storage.fsPath", async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom(...keys), fc.constantFrom(...ats), fc.constantFrom(...givens), async (k, a, g) => {
            expect(fsPath(k, a, g)).toBe(await oracle.ask("fspath", [k, a, g]));
        }), { numRuns: 300 });
    });
    it("shownPath is Storage.shownPath", async () => {
        const reals = (k: string): string[] => ["/", "/x", "/" + opfsDirName(k), "/" + opfsDirName(k) + "/x/y", "/" + opfsDirName(k) + "x", "/" + opfsDirName(k).slice(0, -1)];
        await fc.assert(fc.asyncProperty(fc.constantFrom(...keys), fc.nat(5), async (k, i) => {
            const r = reals(k)[i]!;
            expect(shownPath(k, r)).toBe(await oracle.ask("fsshown", [k, r]));
        }), { numRuns: 100 });
    });
});
