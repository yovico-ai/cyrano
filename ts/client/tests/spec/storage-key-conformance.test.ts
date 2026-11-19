// @vitest-environment node
//
// Conformance of the runtime's storage key (src/patches/storage.ts
// partitionKey) with spec/Storage.agda partitionKey (the spec against
// Chromium: storage-partition-vs-chromium).

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { partitionKey, siteOf } from "../../src/patches/storage";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const ORIGINS = ["https://www.one.com", "https://sub.one.com", "https://two.com", "http://two.com", "https://a.github.io", "https://b.github.io", "https://x.co.uk", "http://127.0.0.1:8"];

describe.skipIf(located.skip !== "")("storage key: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("partitionKey is partitionKey", async () => {
        await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom(...ORIGINS), { maxLength: 3 }), fc.constantFrom(...ORIGINS), async (anc, own) => {
            const sites = anc.map((o) => siteOf(new URL(o)));
            const site = siteOf(new URL(own));
            expect(partitionKey(sites, site, own)).toBe(await oracle.ask("storagekey", [sites.join(" "), site, own]));
        }), { numRuns: 500 });
    });

    it("sites as Chromium makes them", () => {
        expect(siteOf(new URL("https://www.one.com:8443/p"))).toBe("https://one.com");
        expect(siteOf(new URL("https://a.github.io/"))).toBe("https://a.github.io");
        expect(siteOf(new URL("http://127.0.0.1:8/"))).toBe("http://127.0.0.1");
    });

    // The key was the top document's origin, and only when it differed:
    // a same-site frame was partitioned, an A-B-A frame was not, and two
    // tops of one site partitioned a frame apart (recorded in Chromium).
    it("same-site frames first-party, A-B-A third-party, by site", () => {
        expect(partitionKey(["https://one.com"], "https://one.com", "https://sub.one.com")).toBe("https://sub.one.com");
        expect(partitionKey(["https://one.com", "https://two.com"], "https://one.com", "https://www.one.com")).toBe("https://www.one.com^https://one.com");
        expect(partitionKey([siteOf(new URL("https://www.one.com/"))], "https://two.com", "https://two.com"))
            .toBe(partitionKey([siteOf(new URL("https://sub.one.com/"))], "https://two.com", "https://two.com"));
    });
});
