// @vitest-environment node
//
// spec/Features.agda against Chromium: window.open with random features
// strings built of keys, values, separators and attributionsrc features
// (their URLs percent-encoded or not). The attribution sources Chromium
// requests are, as a set, the spec's `featuresources` decoded.
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";
const seed = Number(process.env.CYRANO_SEED ?? Date.now() % 1e9);

type Page = { goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T, a: A): Promise<T>; waitForTimeout(ms: number): Promise<void>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void>; pages(): Page[] };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };

const PIECES = ["attributionsrc", "AttributionSrc", "attributionsrcx", "noopener", "popup", "width", "=", " = ", ",", " ", "\t", "\n", "\f", "yes", "a b", "=,", ",=", "x", "SRC", "ESRC"];

describe.skipIf(!wanted || located.skip !== "")("window.open's attributionsrc: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;
    const seen = new Map<string, Set<string>>();

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req, res) => {
            const m = /^\/s\/(\d+)\/(.*)$/.exec(req.url ?? "");
            if (m) { if (!seen.has(m[1]!)) seen.set(m[1]!, new Set()); seen.get(m[1]!)!.add(m[2]!); }
            res.setHeader("Content-Type", "text/html");
            res.end("<!doctype html>x");
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        oracle?.close();
        await browser?.close();
        server?.close();
    });

    it("the sources requested are the spec's", async () => {
        // Features of key, joiner and value, joined by separators and junk.
        const feature = fc.tuple(fc.constantFrom("attributionsrc", "AttributionSrc", "attributionsrcx", "noopener", "popup", "width"),
            fc.constantFrom("=", " = ", " ", "", "=,", " x=", "\t=\n", ","), fc.constantFrom("SRC", "ESRC", "yes", "", "SRC"))
            .map(([k, j, v]) => [k, j, v]);
        const draws = fc.sample(fc.array(fc.tuple(feature, fc.constantFrom(...PIECES, ",", ",", " ", " ")).map(([f, junk]) => [...f, junk]), { minLength: 1, maxLength: 4 })
            .map((fs) => fs.flat()), { numRuns: 80, seed });
        // A few that always request, so no seed leaves the check vacuous.
        draws.push(["attributionsrc", "=", "SRC"], ["AttributionSrc", "=", "ESRC", " ", "attributionsrc", "=", "SRC"],
            ["popup", ",", "attributionsrc", " = ", "SRC"], ["attributionsrc", "=", "SRC", ",", "attributionsrc", "=", "ESRC"]);
        // Each SRC / ESRC piece a URL of its own: plain or percent-encoded.
        const cases = draws.map((ps, k) => { let j = 0; return ps.map((p) => p === "SRC" ? `/s/${k}/${j++}` : p === "ESRC" ? encodeURIComponent(`/s/${k}/${j++}`) : p).join(""); });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(`http://localhost:${port}/`);
        for (let k = 0; k < cases.length; k++) {
            await page.evaluate(([f, n]: [string, number]) => { window.open(`/nav/${n}`, `w${n}`, f); }, [cases[k]!, k] as [string, number]);
            await page.waitForTimeout(150);
        }
        // Under load the browser's attribution requests come late: wait
        // until the counts settle.
        let before = -1;
        for (let i = 0; i < 20; i++) {
            await page.waitForTimeout(500);
            const now = [...seen.values()].reduce((a, s) => a + s.size, 0);
            if (now === before) break;
            before = now;
        }
        await ctx.close();
        const bad: string[] = [];
        let requested = 0, wanted = 0;
        for (let k = 0; k < cases.length; k++) {
            const spec = ((await oracle.ask("featuresources", [cases[k]!]))!).split("\n").filter((v) => v !== "").map((v) => decodeURIComponent(v));
            const want = new Set(spec.flatMap((p) => { return p.startsWith(`/s/${k}/`) ? [p.slice(`/s/${k}/`.length)] : []; }));
            const got = seen.get(String(k)) ?? new Set<string>();
            requested += got.size; wanted += want.size;
            if ([...want].sort().join() !== [...got].sort().join()) bad.push(`${JSON.stringify(cases[k])}: Chromium requested ${JSON.stringify([...got])}, spec ${JSON.stringify([...want])}`);
        }
        expect(bad.slice(0, 10), `${bad.length} (seed ${seed})`).toEqual([]);
        expect(wanted).toBeGreaterThanOrEqual(6);
        expect(requested).toBe(wanted);
    }, 120_000);
});
