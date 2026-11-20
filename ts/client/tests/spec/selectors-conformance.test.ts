// @vitest-environment node
//
// Conformance of the runtime's selector widening (src/patches/selectors.ts
// widenSelector) with spec/Selectors.agda, asked live (the spec against
// Chromium: selectors-vs-chromium).

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { widenSelector } from "../../src/patches/selectors";
import { rewriteUrl } from "../../src/url/containment";
import type { ClientConfig } from "../../src/config";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const config = (proxy: string): ClientConfig => ({ apiBaseURL: proxy, source: "/rewriter.js", cacheKey: "t", version: "t", rewrite_css_selectors: false });
const PROXY = "http://p.example:9081";
const BASE = "https://site.example/dir/page";

const names = ["src", "SRC", "href", "data", "xlink:href", "id", "action", "ping", "title", "srcset", "imageSrcset"];
const ops = ["=", "^=", "*=", "$=", "~="];
const values = ["https://cdn.example/a.js", "/a.js", "a.js", "//cdn.example/a", "https", "http:", "HTTPS://", "#x", "data:x", "", "https://h.example/p?q=\"1\"",
    "\\2f a", "x\\\"y", "https://h.example/\\6e ew", "javascript:x", "//", "//h", "http://h.example/a b", "./media_", "a.png 1x", "a.png,b.png"];
const quote = ["\"", "'", ""];
const flags = ["", " i", "s", " S"];
const outside = ["a", "script", " ", ", ", "div > ", ":not(", ")", "\"str[\"", "\\[", "[", "]"];

describe.skipIf(located.skip !== "")("selectors: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("widenSelector is widenSelector", async () => {
        const bracket = fc.tuple(fc.constantFrom(...names), fc.constantFrom(...ops), fc.constantFrom(...quote), fc.constantFrom(...values), fc.constantFrom(...flags),
            fc.constantFrom("", " "))
            .map(([n, o, q, v, f, sp]) => `[${sp}${n}${sp}${o}${sp}${q}${q === "" ? v.replace(/[\s"'\]]/g, "") : v.split(q).join("\\" + q)}${q}${f}${sp}]`);
        const selector = fc.array(fc.oneof(bracket, fc.constantFrom(...outside)), { minLength: 1, maxLength: 5 }).map((a) => a.join(""));
        await fc.assert(fc.asyncProperty(selector, async (sel) => {
            let got: string;
            try { got = widenSelector(sel, (u) => rewriteUrl(u, new URL(BASE), config(PROXY)), PROXY); } catch { got = sel; }
            expect(got, JSON.stringify(sel)).toBe(await oracle.ask("widenselector", [PROXY, BASE, sel]));
        }), { numRuns: 2000 });
    });
});
