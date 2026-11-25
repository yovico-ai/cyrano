// @vitest-environment node
//
// document.featurePolicy's answers (src/url/feature-policy.ts) against
// spec/Permissions.agda allows / allowlist, the table the server gives a
// document taken from the spec's own (pptable; Go's PermissionsTable is
// checked against the same).

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { allowlistBy, allowsBy, type PolicyTable } from "../../src/url/feature-policy";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const keys = ["geolocation", "camera", "fullscreen", "payment", "x-unknown"];
const members = ["*", "self", "src", "?1", `"https://a.example"`, `"https://*.a.example"`, `"https://u@a.example:8443/p"`, `"*"`, `"'self'"`, `"'none'"`, `"https://doc.example"`, `"http://doc.example"`, `"https://b.example:8443"`];
const origins = ["https://doc.example", "https://a.example", "https://x.a.example", "https://a.example:8443", "https://b.example:8443", "http://doc.example"];
const DOC = "https://doc.example";

describe.skipIf(located.skip !== "")("document.featurePolicy: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("allowsBy / allowlistBy are Permissions.allows / allowlist", async () => {
        const entry = fc.tuple(fc.constantFrom(...keys), fc.integer({ min: 0, max: 2 }), fc.array(fc.constantFrom(...members), { maxLength: 3 }))
            .map(([k, form, ms]) => (form === 0 ? k : form === 1 ? k + "=" + (ms[0] ?? "*") : k + "=(" + ms.join(" ") + ")"));
        await fc.assert(fc.asyncProperty(fc.array(entry, { minLength: 0, maxLength: 4 }), fc.constantFrom(...keys), fc.boolean(), fc.constantFrom(...origins),
            async (es, f, defaultAll, o) => {
                const lines = es.join(", ");
                const t = await oracle.ask("pptable", [lines]);
                const table: PolicyTable | null = t === null || t === "none" ? null : t === "" ? [] : t.split("\n").map((r) => r.split("\u001f"));
                const want = await oracle.ask("ppallows", [lines, f, defaultAll ? "1" : "0", DOC, o]);
                expect(allowsBy(table, defaultAll, f, DOC, o) ? "yes" : "no", JSON.stringify([lines, f, o])).toBe(want);
                const wantL = await oracle.ask("ppallowlist", [lines, f, defaultAll ? "1" : "0", DOC]);
                expect(allowlistBy(table, defaultAll, f, DOC).join("\n"), JSON.stringify([lines, f])).toBe(wantL ?? "");
            }), { numRuns: 300 });
    });
});
