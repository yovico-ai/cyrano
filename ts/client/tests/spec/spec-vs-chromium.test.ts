// @vitest-environment node
//
// "The spec is the browser", against a real browser: the Agda spec's
// `direct` (what the browser shows for a URL, without cyrano) must equal
// what headless Chromium's own URL parser gives, over the same generated
// inputs the conformance properties use. conformance.test.ts checks the
// same against Node (Ada); Chromium is the browser cyrano's server emulates,
// and the two differ (see fixtures/idna.json).
//
// Needs the oracle and the Playwright Chromium from ts/e2e; `make
// browser-check` runs it. Skipped otherwise.

import { createRequire } from "node:module";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bases, proxies, url } from "./gen";
import { OracleClient, OutOfModel, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Browser = { newPage(): Promise<{ evaluate<T, A>(f: (a: A) => T, a: A): Promise<T> }>; close(): Promise<void>; version(): string };

describe.skipIf(!wanted || located.skip !== "")("spec is Chromium", () => {
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

    it("direct is Chromium's href", async () => {
        const draws = fc.sample(
            fc.constantFrom(...proxies).chain((p) => fc.tuple(fc.constantFrom(...bases), url(p))),
            { numRuns: 5000, seed: Number(process.env.CYRANO_SEED ?? Date.now() % 1e9) },
        );
        const page = await browser.newPage();
        const native = await page.evaluate(
            (xs: [string, string][]) => xs.map(([b, r]) => { try { return new URL(r, b).href; } catch { return null; } }),
            draws,
        );
        const mismatches: string[] = [];
        for (let i = 0; i < draws.length; i++) {
            const [base, raw] = draws[i]!;
            let want;
            try {
                want = await oracle.direct(base, raw);
            } catch (e) {
                if (e instanceof OutOfModel) continue;
                throw e;
            }
            const got = native[i] ?? null;
            const ok = want.kind === "shownDirect" ? got === want.out
                : want.kind === "unparseable" ? got === null
                : got === null || !/^(https?|wss?):/.test(got);
            if (!ok) mismatches.push(`${JSON.stringify(raw)} on ${base}: spec ${want.kind} ${JSON.stringify(want.out)}, chromium ${JSON.stringify(got)}`);
        }
        expect(mismatches.slice(0, 20), `${mismatches.length} of ${draws.length} differ (chromium ${browser.version()})`).toEqual([]);
    }, 120_000);
});
