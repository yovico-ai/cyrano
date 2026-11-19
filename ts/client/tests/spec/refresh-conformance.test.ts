// @vitest-environment node
//
// Conformance of the runtime's refresh rewriting (src/url/refresh.ts) with
// spec/Refresh.agda, asked live (Go: urlrewrite TestSpecConformance_Refresh;
// the spec against Chromium: refresh-vs-chromium).

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rewriteRefresh } from "../../src/url/refresh";
import { rewriteUrl } from "../../src/url/containment";
import type { ClientConfig } from "../../src/config";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";
import { bases, proxies } from "./gen";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const times = ["0", "0.", ".", "0.7", " 0", "00", "", "x", "0x", "-0", ".5", "0.5.5", "+0", "\f0", "5"];
const seps = ["", ";", ",", " ", " ; ", ";;", "\t,", "; ,"];
const urls = ["url=/t/a", "URL = '/t/b' tail", "ux/t/c", "url /t/e", "'/t/f'", "\"/t/g", "/t/h\"x", "urL=\"/t/i\"", "",
    "  ", "url=", "url='", "url=?q", "//other.example/k", "'/t/l'x'", "''", "url\f=/t/n", "https://x.example/p q", "url=\"https://y.example/\""];
const config = (proxy: string): ClientConfig => ({ apiBaseURL: proxy, source: "/rewriter.js", cacheKey: "t", version: "t", rewrite_css_selectors: false });

describe.skipIf(located.skip !== "")("Refresh: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("rewriteRefresh is rewriteRefresh", async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom(...proxies), fc.constantFrom(...bases), fc.constantFrom(...times), fc.constantFrom(...seps), fc.constantFrom(...urls),
            async (proxy, base, t, s, u) => {
                const v = t + s + u;
                expect(rewriteRefresh(v, (x) => rewriteUrl(x, new URL(base), config(proxy))), JSON.stringify(v)).toBe(await oracle.ask("refresh", [proxy, base, v]));
            }), { numRuns: 600 });
    });
});
