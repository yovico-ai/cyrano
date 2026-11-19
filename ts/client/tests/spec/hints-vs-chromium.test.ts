// @vitest-environment node
//
// spec/Hints.agda against Chromium: after a page's Accept-CH, the hints the
// next navigation carries are the spec's (`acceptch`; of the hints Chromium
// knows), and a second Accept-CH replaces, clears or — invalid or absent —
// keeps the set (`updateSet`, checked through acceptch).
//
// localhost is a secure context, where Chromium honours Accept-CH.
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";
const seed = Number(process.env.CYRANO_SEED ?? Date.now() % 1e9);

type Page = { goto(u: string): Promise<unknown>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };

const KNOWN = ["sec-ch-ua-arch", "sec-ch-ua-model", "sec-ch-ua-bitness", "sec-ch-ua-full-version-list", "sec-ch-ua-platform-version", "dpr", "device-memory"];
const NAMES = ["sec-ch-ua-arch", "Sec-CH-UA-Model", "SEC-CH-UA-BITNESS", "dpr", "device-memory", "x-unknown", "*", "sec-ch-ua-full-version-list"];
const PIECES = [...NAMES, ...NAMES, ", ", ",", " , ", "\t,", ";q=0.5", ";a", ";", "(", ")", "\"s\"", "1", "?1", " ", ":aGk=:", ",,"];

describe.skipIf(!wanted || located.skip !== "")("Client hints: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;
    let ach: string | null = null;
    let seen = "";
    let ua: [string, string] = ["", ""];

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req, res) => {
            const h: Record<string, string> = { "content-type": "text/html" };
            if ((req.url ?? "").startsWith("/p") && ach !== null) h["accept-ch"] = ach;
            seen = Object.keys(req.headers).filter((x) => KNOWN.includes(x)).sort().join(" ");
            ua = [String(req.headers["sec-ch-ua"] ?? ""), String(req.headers["user-agent"] ?? "")];
            res.writeHead(200, h);
            res.end("x");
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

    const known = (names: string): string => names.split(" ").filter((n) => KNOWN.includes(n)).filter((n, i, a) => a.indexOf(n) === i).sort().join(" ");

    it("the hints sent after an Accept-CH, and after a second one", async () => {
        const value = fc.array(fc.constantFrom(...PIECES), { minLength: 1, maxLength: 6 }).map((a) => a.join(""));
        const draws = fc.sample(fc.tuple(value, fc.option(value, { nil: null })), { numRuns: 120, seed });
        const bad: string[] = [];
        for (const [first, second] of draws) {
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            ach = first;
            await page.goto(`http://localhost:${port}/p1`);
            ach = null;
            await page.goto(`http://localhost:${port}/n1`);
            const afterFirst = seen;
            ach = second;
            await page.goto(`http://localhost:${port}/p2`);
            ach = null;
            await page.goto(`http://localhost:${port}/n2`);
            const afterSecond = seen;
            await ctx.close();
            const a = (await oracle.ask("acceptch", [first]))!;
            const set1 = a === "none" ? "" : known(a);
            let set2 = set1;
            if (second !== null) {
                const b = (await oracle.ask("acceptch", [second]))!;
                if (b !== "none") set2 = known(b);
            }
            if (afterFirst !== set1) bad.push(`${JSON.stringify(first)}: Chromium "${afterFirst}", spec "${set1}"`);
            if (afterSecond !== set2) bad.push(`${JSON.stringify(first)} then ${JSON.stringify(second)}: Chromium "${afterSecond}", spec "${set2}"`);
        }
        expect(bad.slice(0, 12), `${bad.length} (seed ${seed})`).toEqual([]);
    }, 300_000);

    it("Sec-CH-UA is the spec's for the browser's version (secchua)", async () => {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(`http://localhost:${port}/n0`);
        await ctx.close();
        const m = /(HeadlessChrome|Chrome)\/(\d+)/.exec(ua[1]);
        expect(m, ua[1]).not.toBeNull();
        expect(ua[0]).toBe(await oracle.ask("secchua", [m![2]!, m![1] === "Chrome" ? "Google Chrome" : m![1]!]));
    });
});
