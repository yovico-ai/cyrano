// @vitest-environment node
//
// Conformance of the runtime's choice of blob: documents to rewrite
// (src/patches/blob-document.ts htmlDocumentType) with spec/Frames.agda
// blobDocument, and of what resolves against a blob: base (hasScheme) with
// blobBase. Its effect in Chromium: tests/native/blob-document-vs-chromium.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hasScheme, htmlDocumentType } from "../../src/patches/blob-document";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const part = fc.constantFrom("text/html", "TEXT/HTML", "Text/Html", "text/plain", "application/xhtml+xml", "image/svg+xml", "", " ", "\t", ";", "charset=utf-8", "text/htmlx", "text/ html", "\n", "\u00a0", "İ");

describe.skipIf(located.skip !== "")("blob documents: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("htmlDocumentType is blobDocument", async () => {
        await fc.assert(fc.asyncProperty(fc.array(part, { maxLength: 4 }), async (ps) => {
            const t = ps.join("");
            expect(htmlDocumentType(t) ? "yes" : "no").toBe(await oracle.ask("blobdocument", [t]));
        }), { numRuns: 500 });
    });

    it("hasScheme is blobBase", async () => {
        const unit = fc.constantFrom("a", "Z", "h", "t", "p", "s", "1", "+", "-", ".", ":", "/", " ", "\t", "\u0000", "\u001f", "é", "?", "#", "_");
        await fc.assert(fc.asyncProperty(fc.string({ maxLength: 8, unit }), async (r) => {
            expect(hasScheme(r) ? "yes" : "no").toBe(await oracle.ask("blobbase", [r]));
        }), { numRuns: 800 });
    });
});
