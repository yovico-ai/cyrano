// @vitest-environment node
//
// Conformance of src/url/import-map.ts with spec/ImportMap.agda, asked
// live (Go: urlrewrite TestSpecConformance_ImportMap; the spec's JSON
// reading against Chromium: json-vs-chromium).

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rewriteImportMapText, rewriteImportMapTwin, rewriteRuleSetText } from "../../src/url/import-map";
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
            expect(rewriteImportMapText(t, (u) => rewriteUrl(u, new URL(base), config(proxy), undefined, "js")), JSON.stringify(t)).toBe(want);
        }), { numRuns: 800 });
    });

    it("rewriteImportMapTwin is rewriteImportMapT", async () => {
        const scoped = fc.tuple(fc.constantFrom('"/"', '"/s/"', '"https://cdn.example/"', '"./"'), fc.constantFrom(":", " : "),
            fc.constantFrom('{"a":"/a.js"}', '{ "a" : "./a.js" , "b":"bare"}', '"x"', "[1]", "{}"), fc.constantFrom("", ' ,"/t/":{}'))
            .map(([k, c, v, more]) => `{"scopes":{${k}${c}${v}${more}}}`);
        await fc.assert(fc.asyncProperty(fc.constantFrom(...proxies), fc.constantFrom(...bases), fc.oneof(text, scoped), fc.constantFrom("-", "-", "origin", "no-referrer"),
            fc.constantFrom("-", "-", "frame", "inert"), async (proxy, base, t, pol, dd) => {
                const want = await oracle.ask("importmap", [proxy, base, pol, dd, t]);
                const b = new URL(base);
                const got = rewriteImportMapTwin(t, (u) => rewriteUrl(u, b, config(proxy), undefined, "js"),
                    (u) => rewriteUrl(u, b, config(proxy), pol === "-" ? undefined : pol, dd === "-" ? undefined : (dd as "frame" | "inert")));
                expect(got, JSON.stringify([t, pol, dd])).toBe(want);
            }), { numRuns: 400 });
    });

    // A speculation rule set (spec/Speculation.agda rewriteRuleSet).
    it("rewriteRuleSetText is rewriteRuleSet", async () => {
        const url = fc.constantFrom('"https://www.immi-usa.com/blog/"', '"/about-us/"', '"rel/x"', '"//h.example/r"', '"mailto:a@b"', '"a\\"b"', '"\\u00e9"', '""', '"#f"');
        const list = fc.array(url, { maxLength: 3 }).map((u) => u.join(", "));
        const rule = fc.tuple(fc.constantFrom('"urls"', '"url"', '"where"'), list).chain(([k, l]) => fc.constantFrom(
            `{"source":"list",${k}:[${l}],"eagerness":"immediate"}`, `{"source":"document","where":{"href_matches":"/*"}}`,
            `{"source":"list",${k}:[[${l}]]}`, `{"tag":"urls",${k}:[${l}]}`));
        const rs = fc.oneof(rule.map((r) => `{"prefetch":[${r}]}`), rule.map((r) => ` {"prerender": [ ${r} ] } `), rule.map((r) => `{"prefetch":[${r}]`),
            fc.constant('{urls:["/x"]}'), fc.array(fc.constantFrom(...pieces, '"urls"'), { maxLength: 12 }).map((p) => p.join("")));
        await fc.assert(fc.asyncProperty(fc.constantFrom(...proxies), fc.constantFrom(...bases), rs, async (proxy, base, t) => {
            const want = await oracle.ask("ruleset", [proxy, base, t]);
            expect(rewriteRuleSetText(t, (u) => rewriteUrl(u, new URL(base), config(proxy))), JSON.stringify(t)).toBe(want);
        }), { numRuns: 600 });
    });

    it("isUrlLikeSpecifier is urlLike", async () => {
        for (const s of ["react", "/x", "./x", "../x", "https://a/", "foo:bar", "http:", "x/y", " https://a/", "a:", "1a:b", "data:,x", "HTTP://A"]) {
            expect(isUrlLikeSpecifier(s), s).toBe((await oracle.ask("urllike", [s])) === "yes");
        }
    });
});
