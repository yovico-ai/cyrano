// @vitest-environment node
//
// Conformance of the Cookie Store model in src/cookies/rfc.ts
// (cookieStoreSet / Delete / Query) with spec/Cookies.agda, asked live.
// (The spec itself is checked against Chrome in cookie-store-vs-chromium.)

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cookieStoreDelete, cookieStoreQuery, cookieStoreSet, itemSameSite, jarCookies, wireName, wireValue, type StoredCookie, type StoreErr } from "../../src/cookies/rfc";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

export const storeNames = ["a", "sid", "__Host-x", "__host-x", "__Secure-y", "", " sp", "sp ", "i s", "n=m", "a;b", "t\tb", "é", "c\x01"];
export const storeValues = ["1", "", "v=w", " padded", "a b", "__Host-v", "x;y", "x".repeat(4095), "\x7f"];
export const storeDomains: (string | null)[] = [null, "", "a.example", ".a.example", "www.a.example", "A.Example", "b.example", "example", "sub.www.a.example", "1.2.3.4"];
export const storePaths: (string | null)[] = [null, "", "/", "/app", "/app/", "app", "/other", "/" + "p".repeat(1030)];
const urls = ["https://www.a.example/app/page?x", "https://a.example/", "https://www.a.example/app", "https://sub.www.a.example/app/page", "https://1.2.3.4/app/"];

const opt = (v: string | null): string => (v === null ? "-" : `=${v}`);
const answer = (r: StoredCookie | { error: StoreErr }): string => ("error" in r ? `!${r.error}` : `${wireName(r)}\n${wireValue(r)}`);

describe.skipIf(located.skip !== "")("Cookie Store: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("set", async () => {
        await fc.assert(fc.asyncProperty(
            fc.constantFrom(...urls), fc.constantFrom(...storeNames), fc.constantFrom(...storeValues),
            fc.constantFrom(...storeDomains), fc.constantFrom(...storePaths), fc.constantFrom("n", "l", "t"), fc.boolean(), fc.boolean(),
            async (u, name, value, domain, path, ss, ps, later) => {
                const want = await oracle.ask("cookiestoreset", [later ? "later" : "139", ps ? "yes" : "no", u, name, value, opt(domain), opt(path), ss]);
                const got = answer(cookieStoreSet(later, ps, new URL(u), { name, value, domain, path, sameSite: ss as "n" | "l" | "t" }));
                expect(got, JSON.stringify({ u, name, value, domain, path, ss, ps })).toBe(want);
            }), { numRuns: 1500 });
    });

    it("delete", async () => {
        await fc.assert(fc.asyncProperty(
            fc.constantFrom(...urls), fc.constantFrom(...storeNames), fc.constantFrom(...storeDomains), fc.constantFrom(...storePaths), fc.boolean(), fc.boolean(),
            async (u, name, domain, path, ps, later) => {
                const want = await oracle.ask("cookiestoredelete", [later ? "later" : "139", ps ? "yes" : "no", u, name, opt(domain), opt(path)]);
                expect(answer(cookieStoreDelete(later, ps, new URL(u), name, domain, path))).toBe(want);
            }), { numRuns: 500 });
    });

    it("get / getAll", async () => {
        // A jar of cookies such sets wrote, plus foreign entries.
        const stored = fc.tuple(fc.constantFrom(...urls), fc.constantFrom("a", "sid", "é", ""), fc.constantFrom("1", "v"),
            fc.constantFrom(null, "a.example", "www.a.example"), fc.constantFrom(null, "/app", "/", "/other"), fc.constantFrom("n", "l", "t"))
            .map(([u, name, value, domain, path, ss]) => cookieStoreSet(false, false, new URL(u), { name, value, domain, path, sameSite: ss as "n" | "l" | "t" }));
        await fc.assert(fc.asyncProperty(
            fc.array(stored, { maxLength: 6 }), fc.constantFrom(...urls), fc.constantFrom(null, "a", "sid", ""),
            async (cs, u, name) => {
                const jar = [...cs.filter((c): c is StoredCookie => !("error" in c)).map((c) => `${wireName(c)}=${wireValue(c)}`), "plain=1"].join("; ");
                const want = await oracle.ask("cookiestoreget", [u, opt(name), jar]);
                const got = cookieStoreQuery(new URL(u), name, jarCookies(jar))
                    .map((c) => [c.name, c.value, c.hostOnly ? "-" : c.domain, c.path, itemSameSite(c.sameSite), c.secure ? "yes" : "no"].join("\t")).join("\n");
                expect(got).toBe(want);
            }), { numRuns: 500 });
    });
});
