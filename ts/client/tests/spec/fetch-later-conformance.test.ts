// @vitest-environment node
//
// Conformance of the runtime's fetchLater quota (src/patches/fetch-later.ts
// deferredSize, quotaRefusal) with spec/FetchLater.agda; the spec against
// Chromium: fetch-later-vs-chromium.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deferredSize, quotaRefusal } from "../../src/patches/fetch-later";
import { BODIES, HEADERS, URLS, makeBody, sizeArgs } from "./fetch-later-cases";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

describe.skipIf(located.skip !== "")("fetchLater quota: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("deferredSize is deferredSize", async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom(...URLS), fc.constantFrom(...HEADERS), fc.constantFrom(...BODIES), fc.nat(3000), async (url, headers, kind, n) => {
            const want = await oracle.ask("fetchlatersize", sizeArgs(url, headers, kind, n));
            expect(String(deferredSize(new URL(url), { headers, body: makeBody(kind, n) ?? null }, Headers))).toBe(want);
        }), { numRuns: 300 });
    });

    // What is deferred never exceeds the quota (only admitted requests count).
    it("quotaRefusal is admit", async () => {
        await fc.assert(fc.asyncProperty(fc.nat(65536), fc.nat(70000), async (used, size) => {
            const want = await oracle.ask("fetchlateradmit", [String(used), String(size)]);
            expect(quotaRefusal(used, size) ?? "ok").toBe(want);
        }), { numRuns: 300 });
    });
});
