// @vitest-environment node
//
// "The spec is the browser", for the JSON spec/ImportMap.agda reads: a text
// is a JSON object to the spec (`jsonobject`) exactly when Chromium's
// JSON.parse gives an object.
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { evaluate<T, A>(f: (a: A) => T, a: A): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void>; version(): string };

const pieces = ["{", "}", "[", "]", ":", ",", " ", "\n", "\t", "\r", "\f", '"a"', '"imports"', '"\\u00e9"', '"\\ud800"', '"\\ud83d\\ude00"',
    '"\\x"', '"\\/"', '"tab\there"', '"\\u12"', "0", "-0", "01", "1.5", "1.", ".5", "1e5", "1E+2", "1e", "-", "true", "false", "null",
    "True", "nul", '"', "'a'", " ", "﻿"];

describe.skipIf(!wanted || located.skip !== "")("JSON: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        oracle?.close();
        await browser?.close();
    });

    it("a JSON object to the spec is one to JSON.parse", async () => {
        const seed = Number(process.env.CYRANO_SEED ?? Date.now() % 1e9);
        const texts = fc.sample(fc.oneof(
            fc.array(fc.constantFrom(...pieces), { maxLength: 12 }).map((p) => p.join("")),
            fc.array(fc.constantFrom(...pieces), { maxLength: 8 }).map((p) => "{" + p.join("") + "}"),
            fc.tuple(fc.constantFrom('"a"', '"b"'), fc.constantFrom(...pieces), fc.constantFrom(...pieces)).map(([k, v, w]) => `{${k}:${v}${w}}`),
        ), { numRuns: 2000, seed });
        const page = await browser.newPage();
        const native = await page.evaluate((ts: string[]) => ts.map((t) => {
            try { const v = JSON.parse(t); return typeof v === "object" && v !== null && !Array.isArray(v); } catch { return false; }
        }), texts);
        await page.close();
        const mismatches: string[] = [];
        for (let i = 0; i < texts.length; i++) {
            const spec = (await oracle.ask("jsonobject", [texts[i]!])) === "yes";
            if (spec !== native[i]) mismatches.push(`${JSON.stringify(texts[i])}: spec ${spec}, chromium ${native[i]}`);
        }
        expect(mismatches.slice(0, 20), `${mismatches.length} differ (chromium ${browser.version()})`).toEqual([]);
    }, 300_000);
});
