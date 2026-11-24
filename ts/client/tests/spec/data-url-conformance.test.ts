// @vitest-environment node
//
// Conformance of the runtime's data: URL reader (src/url/data-url.ts) with
// spec/DataUrl.agda; the spec against Chromium: data-url-vs-chromium.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readDataUrl, rewritable, wrapped } from "../../src/url/data-url";
import { dataDocument } from "../../src/patches/blob-document";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

export const SCHEMES = ["data:", "DATA:", "Data:", " data:", "\tdata:", "dat:", "data", "\x01data:"];
export const HEADS = ["", "text/javascript", "text/javascript;base64", "text/javascript; base64", "text/javascript ;  BASE64",
    ";base64", "application/javascript;charset=utf-8", "text/javascript;charset=latin1", " text/javascript ", "text/javascript;base64 ",
    "text/java\tscript", "a?b", "text/javascript;xbase64", "base64", "é/x", "text/plain;charset=UTF-8;base64"];
export const BODIES = ["", "import(\"https://x.example/a.js\")", "YWI=", "YWI", "Y W I", "YQ==", "YQ=", "Y", "a%20b", "%zz", "%", "%4",
    "é", "ÿ", "#frag", "a#b,c", ",", "?q", "\n\t", "AA==", "AAA=", "YWJj+/8=", "@@", "w6k=", "/w==", "%C3%A9", "%FF", "😀"];

/** A generated data: URL (or near one). */
export const dataUrls = fc.tuple(fc.constantFrom(...SCHEMES), fc.constantFrom(...HEADS), fc.integer({ min: 0, max: 5 }),
    fc.array(fc.constantFrom(...BODIES), { maxLength: 3 }), fc.constantFrom("", "", " ", "\n"))
    .map(([s, h, comma, b, t]) => s + h + (comma > 0 ? "," : "") + b.join("") + t);

const hex = (b: number[]): string => b.map((x) => (x < 16 ? "0" : "") + x.toString(16)).join("");

describe.skipIf(located.skip !== "")("data: URLs: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("dataDocument is Frames.dataDocument", async () => {
        const head = fc.constantFrom("", "text/html", "TEXT/HTML", " text/html ", "text/html;charset=utf-8", "text/html;base64", "text/htmlx", "text/plain", "image/svg+xml", ";base64");
        const body = fc.constantFrom("", "<p>a", "PHA+YQ==", "%3Cp%3E", "é", "%FF", "#f");
        await fc.assert(fc.asyncProperty(fc.constantFrom("data:", "DATA:", " data:", "dat:"), head, fc.boolean(), body, async (sc, h, comma, b) => {
            const u = sc + h + (comma ? "," : "") + b;
            expect(dataDocument(u) ? "yes" : "no").toBe(await oracle.ask("datadoc", [u]));
        }), { numRuns: 300 });
    });

    it("readDataUrl, rewritable and wrapped are the spec's", async () => {
        await fc.assert(fc.asyncProperty(dataUrls, async (u) => {
            const want = await oracle.ask("dataurl", [u]);
            const d = readDataUrl(u);
            const got = d === null ? "none" : [rewritable(d) ? "1" : "0", d.head, hex(d.body), wrapped(d.head, d.body)].join("\t");
            expect(got).toBe(want);
        }), { numRuns: 3000 });
    });
});
