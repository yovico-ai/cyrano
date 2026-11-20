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
        lines.push(`${t.name} ${t.ignored ? "none" : t.ns} ${id}`); // an ignored <form>: no element
    }
    return lines.join("\n");
};

describe.skipIf(located.skip !== "")("HTML tokenization: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    // Where a document.write that ends inside a construct is cut
    // (wrappers/document-write.ts): markup cut anywhere, in code points.
    it("the unfinished tail is htmltail", async () => {
        await fc.assert(fc.asyncProperty(markupArb(), fc.nat(400), fc.boolean(), async (m0, cut, sc) => {
            const cps = [...m0];
            const m = cps.slice(0, cut % (cps.length + 1)).join("");
            const tail = { at: -1 };
            tokenize(m, sc, undefined, tail);
            const got = tail.at < 0 ? "none" : String([...m.slice(0, tail.at)].length);
            expect(got, JSON.stringify(m)).toBe(await oracle.ask("htmltail", [sc ? "1" : "0", m]));
        }), { numRuns: 2000 });
    });

    // The form element pointer (spec formIgnored), a template included.
    it("nested forms: the ignored start tags are the spec's", async () => {
        const cases: [string, boolean][] = [
            ['<form data-i=1><form data-i=2><b data-i=3></b></form><form data-i=4></form>', true],
            ['<p data-i=1><form data-i=2></p><form data-i=3><b data-i=4>', true],
            ['<template data-i=1><form data-i=2><form data-i=3></form></template><form data-i=4><form data-i=5>', true],
            ['<form data-i=1><template data-i=2><form data-i=3></form></template></form><form data-i=4>', false],
            ['<form data-i=1><svg data-i=2><form data-i=3></form></svg><form data-i=4>', true],
            ['</form><form data-i=1></form></form><form data-i=2>', false],
        ];
        for (const [m, ignores] of cases) {
            const want = (await oracle.ask("htmltags", ["1", m])) ?? "";
            expect(startTags(m, true), m).toBe(want);
            expect(want.includes(" none "), m).toBe(ignores);
        }
    });

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
