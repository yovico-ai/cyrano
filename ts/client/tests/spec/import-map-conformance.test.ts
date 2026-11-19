// @vitest-environment node
//
// Conformance of src/url/import-map.ts with spec/ImportMap.agda, asked
// live (Go: urlrewrite TestSpecConformance_ImportMap; the spec's JSON
// reading against Chromium: json-vs-chromium).

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rewriteImportMapText } from "../../src/url/import-map";
import { isUrlLikeSpecifier, rewriteUrl } from "../../src/url/containment";
import type { ClientConfig } from "../../src/config";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";
import { bases, proxies } from "./gen";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const pieces = ["{", "}", "[", "]", ":", ",", " ", "\n", '"imports"', '"scopes"', '"integrity"', '"react"', '"./a.js"', '"/b/"',
    '"https://cdn.example/c.js"', '"../d"', '"lodash/"', '"http:"', '"foo:bar"', '"\\u00e9.js"', '"\\ud800"', '"x\\"y"', "1", "null",
    "true", '"sha384-abc"', '"\\/e.js"', '" /f.js"'];
const keys = ['"react"', '"./a.js"', '"/b/"', '"https://cdn.example/c.js"', '"lodash/"', '" /f.js"'];
const vals = ['"./x.js"', '"/y.js"', '"https://cdn.example/z.js"', '"bare"', "null", "3"];
const text = fc.oneof(
    fc.array(fc.constantFrom(...pieces), { maxLength: 14 }).map((p) => p.join("")),
    fc.tuple(fc.constantFrom(...keys), fc.constantFrom(...vals)).map(([k, v]) => `{"imports":{${k}:${v}},"scopes":{"/s/":{${k}:${v}}},"integrity":{${v}:"sha"}}`),
    fc.array(fc.constantFrom(...pieces), { maxLength: 10 }).map((p) => `{"imports":${p.join("")}}`),
);
const config = (proxy: string): ClientConfig => ({ apiBaseURL: proxy, source: "/rewriter.js", cacheKey: "t", version: "t", rewrite_css_selectors: false });

describe.skipIf(located.skip !== "")("import maps: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("rewriteImportMapText is rewriteImportMap", async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom(...proxies), fc.constantFrom(...bases), text, async (proxy, base, t) => {
            const want = await oracle.ask("importmap", [proxy, base, t]);
            expect(rewriteImportMapText(t, (u) => rewriteUrl(u, new URL(base), config(proxy))), JSON.stringify(t)).toBe(want);
        }), { numRuns: 800 });
    });

    it("isUrlLikeSpecifier is urlLike", async () => {
        for (const s of ["react", "/x", "./x", "../x", "https://a/", "foo:bar", "http:", "x/y", " https://a/", "a:", "1a:b", "data:,x", "HTTP://A"]) {
            expect(isUrlLikeSpecifier(s), s).toBe((await oracle.ask("urllike", [s])) === "yes");
        }
    });
});
