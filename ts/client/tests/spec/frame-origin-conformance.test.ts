// Runs under happy-dom (frame elements). Conformance of the runtime's
// pending frame origin (src/patches/cross-origin-windows.ts pendingOrigin)
// with spec/Frames.agda frameOrigin: an origin where the spec gives one,
// null where the frame is its creator's or opaque (the browser's).
// The spec against Chromium: frame-origin-vs-chromium.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pendingOrigin } from "../../src/patches/cross-origin-windows";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const SRCS = ["https://a.example/f", "http://b.example:8080/x?y#z", "HTTPS://A.EXAMPLE/", "https://u:p@a.example/", "about:blank", "", "javascript:'x'", "JavaScript:void 0", "data:text/html,x",
    "DATA:,x", "blob:https://a.example/uuid", "https:", "http://[::1]:81/", "ftp://a.example/", "httpx://a.example/", "https://a.example:443/"];

describe.skipIf(located.skip !== "")("Pending frame origin: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("pendingOrigin is frameOrigin", async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom(...SRCS), fc.boolean(), fc.constantFrom("iframe", "object"), async (src, srcdoc, tag) => {
            // The element as the runtime reads it: src / data reading back the URL.
            const el = { hasAttribute: (n: string) => n === "srcdoc" && srcdoc, ...(tag === "object" ? { data: src } : { src, srcdoc: "" }) };
            const want = await oracle.ask("frameoriginof", [tag === "object" ? "1" : "0", srcdoc && tag === "iframe" ? "1" : "0", src]);
            const got = pendingOrigin(el);
            expect(got ?? "null", src).toBe(want === "creator" || want === "opaque" ? "null" : want);
        }), { numRuns: 300 });
    });
});
