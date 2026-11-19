// @vitest-environment node
//
// Conformance of the <meta http-equiv="Content-Security-Policy">
// translation (src/patches/html-rewriter.ts rewriteCspContent) with
// spec/Csp.agda translateMeta, asked live. (Go's header and meta
// translations: go/src/internal/urlrewrite/csp_conformance_test.go.)

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rewriteCspContent } from "../../src/patches/html-rewriter";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const names = ["default-src", "script-src", "Script-Src", "script-src-elem", "style-src", "style-src-attr", "img-src",
    "connect-src", "frame-src", "object-src", "worker-src", "font-src", "frame-ancestors", "base-uri", "report-uri",
    "report-to", "trusted-types", "require-trusted-types-for", "upgrade-insecure-requests", "block-all-mixed-content",
    "sandbox", "foo-src", "é-src"];
const values = ["'self'", "'none'", "'NONE'", "'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'", "'nonce-abc'",
    "'Nonce-XyZ'", "'sha256-AAAA'", "'SHA384-bb'", "https:", "data:", "*", "https://cdn.example", "http://localhost:9081",
    "HTTP://LOCALHOST:9081", "/r", "'script'", "default", "_crnpolicy"];
const spaces = [" ", "  ", "\t", "\n", "\f", "\r", "\v", " "];
const directive = fc.tuple(fc.constantFrom("", ...spaces), fc.constantFrom(...names),
    fc.array(fc.tuple(fc.constantFrom(...spaces), fc.constantFrom(...values)), { maxLength: 4 }), fc.constantFrom("", ...spaces))
    .map(([lead, n, vs, trail]) => lead + n + vs.map(([sp, v]) => sp + v).join("") + trail);
const policy = fc.array(fc.tuple(directive, fc.constantFrom(";", "; ", " ;", ";;", ", ")), { maxLength: 5 })
    .map((ds) => ds.map(([d, sep], i) => (i ? sep : "") + d).join(""));

describe.skipIf(located.skip !== "")("CSP: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("rewriteCspContent is translateMeta", async () => {
        await fc.assert(fc.asyncProperty(policy, fc.constantFrom("http://localhost:9081", "https://proxy.example", ""),
            fc.constantFrom("_crnpolicy", ""), async (v, proxy, tt) => {
                const want = await oracle.ask("csp", ["meta", proxy, tt, v]);
                expect(rewriteCspContent(v, proxy, tt || undefined), JSON.stringify({ v, proxy, tt })).toBe(want);
            }), { numRuns: 500 });
    });
});
