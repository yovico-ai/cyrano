// @vitest-environment node
//
// Conformance of the runtime's RequestInit referrer mapping
// (src/patches/fetch.ts initReferrer) with spec/Referrer.agda
// initReferrer, asked live: what the browser would make of the value
// directly, handed to it in the proxied form (the spec against Chromium:
// fetch-vs-chromium).

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { initReferrer } from "../../src/patches/fetch";
import { rewriteUrl } from "../../src/url/containment";
import type { ClientConfig } from "../../src/config";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";
import { proxies } from "./gen";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const pages = ["https://example.com/p/q?x=1#h", "http://other.org/", "https://example.com:8443/a/b"];
const values = ["", "about:client", "ABOUT:CLIENT", "about:blank", "/x", "x#h", "../up?q", "https://example.com/y", "https://example.com",
    "http://example.com/", "https://example.com:8443/z", "http://other.org/o", "data:,x", "javascript:1", " /sp", "http://[", "//example.com/n",
    "?only", "#only", "%zz", "\\back", "https://EXAMPLE.com/c"];
const config = (proxy: string): ClientConfig => ({ apiBaseURL: proxy, source: "/rewriter.js", cacheKey: "t", version: "t", rewrite_css_selectors: false });

describe.skipIf(located.skip !== "")("RequestInit referrer: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("initReferrer is the spec's, proxified", async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom(...proxies), fc.constantFrom(...pages), fc.constantFrom(...values), async (proxy, page, v) => {
            const want = await oracle.ask("initref", [page, page, v]);
            const rw = (u: string): string => rewriteUrl(u, new URL(page), config(proxy));
            const got = initReferrer(v, new URL(page), new URL(page).origin, rw);
            const expected = want === "" || want === "about:client" ? want : want === "TypeError" ? v : rw(want!);
            expect(got, `${page} ${JSON.stringify(v)}`).toBe(expected);
        }), { numRuns: 400 });
    });
});
