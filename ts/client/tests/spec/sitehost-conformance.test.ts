// @vitest-environment node
//
// Conformance of the runtime's site hosts (src/url/site-host.ts) with
// spec/SiteHost.agda and its SHA-256 (spec/Sha256.agda); the SHA-256 also
// against Node's crypto, as the browser's SubtleCrypto computes it.

import { createHash } from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { admits, base32, sha256, siteKey, siteLabel, siteHost } from "../../src/url/site-host";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const bytes = (s: string): number[] => [...Buffer.from(s, "utf8")];
const hex = (b: number[]): string => Buffer.from(b).toString("hex");

describe("site hosts: SHA-256 and base32 as Node's", () => {
    it("matches node:crypto", () => {
        fc.assert(fc.property(fc.string({ maxLength: 200, unit: "binary" }), (s) => {
            expect(hex(sha256(bytes(s)))).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
        }), { numRuns: 300 });
        expect(base32(bytes("foobar"))).toBe("mzxw6ytboi");
    });
});

describe.skipIf(located.skip !== "")("site hosts: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("SHA-256 as the spec's", async () => {
        for (const s of ["", "abc", "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "x".repeat(55), "x".repeat(56), "héllo 😀"]) {
            expect(hex(sha256(bytes(s)))).toBe(await oracle.ask("sha256", [s]));
        }
    });

    it("site keys, labels and admission as the spec's", async () => {
        const hosts = ["www.example.com", "a.b.example.co.uk", "127.0.0.1", "[::1]", "xn--bcher-kva.example", "6093eccf-6734-4877-ac8b-83d6d0e27b46.edgeoptimize.net"];
        for (const sc of ["http", "https", "ws", "wss"]) for (const h of hosts) for (const r of ["", "example.com", "edgeoptimize.net"]) {
            const key = siteKey(sc, h, r);
            expect(key).toBe(await oracle.ask("sitekey", [sc, h, r]));
            expect(siteLabel(key)).toBe(await oracle.ask("sitelabel", [key]));
        }
        const key = "https://example.com";
        for (const host of [siteHost("proxy.test", key), "proxy.test", "a." + siteHost("proxy.test", key), siteLabel(key) + ".other.test", siteHost("proxy.test", "https://other.com")]) {
            expect(admits("proxy.test", host, key) ? "yes" : "no").toBe(await oracle.ask("siteadmits", ["proxy.test", host, key]));
        }
    });
});
