// @vitest-environment node
//
// Conformance of the runtime's tokenizer (src/patches/html-tokens.ts) with
// spec/HtmlTok.agda, asked live: the start tags and their namespaces, the
// attribute spans the client edits at, and where the bootstrap goes (Go: htmlrewrite/htmltok_conformance_test.go;
// the spec against Chromium: html-tok-vs-chromium).

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tokenize, withBootstrap } from "../../src/patches/html-tokens";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";
import { CONTEXTS, documentArb, markupArb } from "./html-gen";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const startTags = (s: string, scripting: boolean, within?: (typeof CONTEXTS)[number]): string => {
    const lines: string[] = [];
    for (const t of tokenize(s, scripting, within)) {
        if (t.kind !== "start") continue;
        const id = t.attrs.find((a) => a.name === "data-i")?.value ?? "-";
        lines.push(`${t.name} ${t.ns} ${id}`);
    }
    return lines.join("\n");
};

describe.skipIf(located.skip !== "")("HTML tokenization: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("start tags and namespaces are htmltags", async () => {
        await fc.assert(fc.asyncProperty(markupArb(), fc.boolean(), async (m, sc) => {
            expect(startTags(m, sc), JSON.stringify(m)).toBe(await oracle.ask("htmltags", [sc ? "1" : "0", m]));
        }), { numRuns: 1500 });
    });

    it("in a context element, start tags are htmltagsin", async () => {
        await fc.assert(fc.asyncProperty(markupArb(), fc.boolean(), fc.constantFrom(...CONTEXTS), async (m, sc, c) => {
            expect(startTags(m, sc, c), `${c.ns}:${c.name} ${JSON.stringify(m)}`).toBe(await oracle.ask("htmltagsin", [sc ? "1" : "0", c.ns, c.name, c.encoding ?? "-", m]));
        }), { numRuns: 1500 });
    });

    it("attribute spans are startSpans", async () => {
        const arb = fc.oneof(markupArb(), documentArb());
        await fc.assert(fc.asyncProperty(arb, async (m) => {
            const got = tokenize(m, true).flatMap((t) => t.kind !== "start" ? [] :
                [`${t.name} ${t.from} ${t.to}` + t.attrs.map((a) => ` ${a.name} ${a.from} ${a.to} ${a.vfrom} ${a.vto}`).join("")]).join("\n");
            expect(got, JSON.stringify(m)).toBe(await oracle.ask("htmlspans", [m]));
        }), { numRuns: 1500 });
    });

    it("the bootstrap goes where bootat puts it", async () => {
        const arb = fc.oneof(markupArb(), documentArb());
        await fc.assert(fc.asyncProperty(arb, async (m) => {
            expect(withBootstrap(m, "\u0000BOOT\u0000"), JSON.stringify(m)).toBe(await oracle.ask("bootat", ["\u0000BOOT\u0000", m]));
        }), { numRuns: 1000 });
    });
});
