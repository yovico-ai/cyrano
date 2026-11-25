// @vitest-environment node
//
// XPath on URL attributes (src/patches/xpath.ts widenXPath) against
// spec/XPath.agda widenXPath.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { widenXPath } from "../../src/patches/xpath";
import { rewriteUrl } from "../../src/url/containment";
import type { ClientConfig } from "../../src/config";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const PROXY = "https://proxy.example";
const BASE = "https://site.example/dir/page";
const config = (proxy: string): ClientConfig => ({ apiBaseURL: proxy, source: "/rewriter.js", cacheKey: "t", version: "t", rewrite_css_selectors: false });

const attrs = ["@href", "@src", "@id", "@data", "@action", "@x:href"];
const ops = ["=", "!=", " = ", "!= ", "="];
const lits = ['"/p?x"', "'https://cdn.example/a.js'", '"#frag"', '"data:x"', '""', "'a.png'", '"mailto:a@b"', "'//h/x'", '"it\'s"'];
const around = ["//a[", "count(//img[", "//*[", "string(", "", "//a[@id='k' and "];
const closes = ["]", "])", ")", "", "] | //b"];

describe.skipIf(located.skip !== "")("XPath on URL attributes: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("widenXPath is XPath.widenXPath", async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom(...around), fc.constantFrom(...attrs), fc.constantFrom(...ops), fc.constantFrom(...lits), fc.boolean(), fc.constantFrom(...closes),
            async (pre, a, o, l, flip, post) => {
                const e = pre + (flip ? l + o + a : a + o + l) + post;
                const got = widenXPath(e, (u) => { try { return rewriteUrl(u, new URL(BASE), config(PROXY)); } catch { return null; } });
                expect(got, JSON.stringify(e)).toBe(await oracle.ask("widenxpath", [PROXY, BASE, e]));
            }), { numRuns: 400 });
    });
});
