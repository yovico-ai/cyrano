// @vitest-environment node
//
// "The spec is the browser", for cookies: what spec/Cookies.agda says a
// script-set cookie string stores, and which pages then see it, must be
// what real Chromium does natively. For each generated string: a fresh
// browser context sets it with document.cookie on one page, and
// document.cookie is read on several pages and hosts; the spec is asked
// the same (`setcookie`, then `cookies` for each URL).
//
// Hosts are *.localhost: Chromium resolves them to loopback and treats
// them as potentially trustworthy, as the spec does.
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T, a: A): Promise<T>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void>; version(): string };

const names = ["a", "sid", "__Host-x", "__Secure-y", "__HOST-z", "", " sp ", "n!m"];
const values = ["1", "", "v=w", " padded ", "a b", "\"q\""];
const attrs = [
    "", "", "Path=/", "Path=/app", "Path=/app/", "path=nope", "Path=", "Path=/other",
    "Domain=site.localhost", "Domain=.site.localhost", "Domain=www.site.localhost", "Domain=SITE.localhost",
    "Domain=other.localhost", "Domain=", "Domain=localhost", "Domain=sub.www.site.localhost",
    "Secure", "secure", "HttpOnly", "SameSite=None", "SameSite=Lax", "SameSite=Strict", "SameSite=bogus",
    "Max-Age=60", "Max-Age=0", "Max-Age=-1", "Max-Age=abc", "Max-Age=", "Unknown=1", " Secure ",
];
const cookieString = fc.tuple(
    fc.constantFrom(...names), fc.boolean(), fc.constantFrom(...values),
    fc.array(fc.constantFrom(...attrs), { maxLength: 4 }),
).map(([n, eq, v, as]) => [eq || n !== "" ? `${n}=${v}` : v, ...as.filter((a) => a !== "")].join("; "));

describe.skipIf(!wanted || located.skip !== "")("cookies: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((_req, res) => {
            res.writeHead(200, { "content-type": "text/html" });
            res.end("<!doctype html><title>t</title>");
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

    it("a script-set cookie is stored and shown as natively", async () => {
        const setAt = `http://www.site.localhost:${port}/app/page`;
        const readAt = [
            setAt,
            `http://www.site.localhost:${port}/`,
            `http://www.site.localhost:${port}/app`,
            `http://www.site.localhost:${port}/application`,
            `http://www.site.localhost:${port}/other/x`,
            `http://site.localhost:${port}/app/page`,
            `http://sub.www.site.localhost:${port}/app/page`,
            `http://other.localhost:${port}/app/page`,
        ];
        // Public-suffix data is outside the spec: the caller says whether the
        // Domain attribute in force (the last one) is a public suffix.
        const publicSuffix = (s: string) => {
            const ds = [...s.matchAll(/;\s*domain\s*=([^;]*)/gi)];
            const last = ds.length ? ds[ds.length - 1]![1]!.trim().toLowerCase().replace(/^\./, "") : "";
            return last === "localhost";
        };
        const draws = fc.sample(cookieString, { numRuns: 150, seed: Number(process.env.CYRANO_SEED ?? Date.now() % 1e9) });
        const mismatches: string[] = [];
        for (const s of draws) {
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            await page.goto(setAt);
            await page.evaluate((v: string) => { document.cookie = v; }, s);
            const native: string[] = [];
            for (const u of readAt) {
                await page.goto(u);
                native.push(await page.evaluate(() => document.cookie, null));
            }
            await ctx.close();

            const stored = await oracle.ask("setcookie", ["api", publicSuffix(s) ? "ps" : "nops", setAt, s]);
            const expiredNow = /(^|;)\s*max-age\s*=\s*(0|-\d+)\s*(;|$)/i.test(s) && stored !== null &&
                /^=(0|-\d+)$/.test(stored.split("\n")[8] ?? "");
            for (let i = 0; i < readAt.length; i++) {
                let want = "";
                if (stored !== null && !expiredNow) {
                    const l = stored.split("\n");
                    want = (await oracle.ask("cookies", ["api", readAt[i]!, `${l[10]}=${l[11]}`])) ?? "";
                }
                if (want !== native[i]) mismatches.push(`${JSON.stringify(s)} read at ${readAt[i]}: spec ${JSON.stringify(want)}, chromium ${JSON.stringify(native[i])}`);
            }
        }
        expect(mismatches.slice(0, 25), `${mismatches.length} differ (chromium ${browser.version()})`).toEqual([]);
    }, 300_000);
});
