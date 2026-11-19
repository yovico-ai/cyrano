// @vitest-environment node
//
// Conformance of the runtime's allow-attribute rewriting (src/url/allow.ts)
// with spec/Allow.agda, asked live (Go: urlrewrite
// TestSpecConformance_RewriteAllow; the spec against Chromium:
// allow-vs-chromium).

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rewriteAllow } from "../../src/url/allow";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const words = ["fullscreen", "camera", "Camera", "*", "'self'", "'SELF'", "'src'", "'none'", "self", "https://a.example", "https://a.example:8443/p?q",
    "http://u@h.example", "http://:@h.example", "data:x", "junk", "https://*.a.example", "ws://h", "https://[::1]", "'self", "http:/x", "HTTPS://A.EXAMPLE", "ftp://f", "http://"];
const pieces = [...words, " ", "  ", "\t", "\n", "\f", "\r", ";", "; ", ";;"];

describe.skipIf(located.skip !== "")("iframe allow: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("rewriteAllow is rewriteAllow", async () => {
        await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom(...pieces), { minLength: 1, maxLength: 10 }), async (ps) => {
            const v = ps.join("");
            expect(rewriteAllow(v), JSON.stringify(v)).toBe(await oracle.ask("allowrewrite", [v]));
        }), { numRuns: 2000 });
    });
});
