// @vitest-environment node
//
// "The spec is the browser", for spec/Refresh.agda: what Chromium does with
// a Refresh header and a <meta http-equiv=refresh> — nothing, a reload, or
// a navigation to a URL — is what the spec reads (`refreshread`).
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

type Page = { goto(u: string): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };

const TIMES = ["0", "0.", ".", "0.7", " 0", "00", "", "x", "0x", "-0", ".5", "0.5.5", "+0", "0e0", "\f0"];
const SEPS = ["", ";", ",", " ", " ; ", ";;", "\t,", "; ,"];
const URLS = ["url=/t/a", "URL = '/t/b' tail", "ux/t/c", "u/t/d", "url /t/e", "'/t/f'", "\"/t/g", "/t/h\"x", "urL=\"/t/i\"", "uRl= /t/j ",
    "", "  ", "url=", "url='", "url=?q", "//other.localhost/t/k", "url=#frag", "'/t/l'x'", "''", "url = /t/m", "url\f=/t/n",
    "url=\"/t/o' ", "/t/p \t", "\f/t/q"];

describe.skipIf(!wanted || located.skip !== "")("Refresh: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let ctx: Context;
    let server: Server;
    let port = 0;
    const hits: string[] = [];
    let current = { value: "", header: false };

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u === "/favicon.ico") { res.writeHead(404); res.end(); return; }
            hits.push(u);
            if (u.startsWith("/p")) {
                const h: Record<string, string> = { "content-type": "text/html" };
                if (current.header) h["refresh"] = current.value;
                res.writeHead(200, h);
                const meta = current.header ? "" : `<meta http-equiv="refresh" content="${current.value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;
                res.end(`<!doctype html><head>${meta}</head><body>p</body>`);
                return;
            }
            res.writeHead(200, { "content-type": "text/html" });
            res.end("<!doctype html><body>t</body>");
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(): Promise<Browser> } };
        browser = await chromium.launch();
        ctx = await browser.newContext();
    });
    afterAll(async () => {
        oracle?.close();
        await browser?.close();
        server?.close();
    });

    it("nothing, a reload, or the URL the spec reads", async () => {
        const draws = fc.sample(fc.tuple(fc.constantFrom(...TIMES), fc.constantFrom(...SEPS), fc.constantFrom(...URLS), fc.boolean()), { numRuns: 120, seed });
        const bad: string[] = [];
        for (let k = 0; k < draws.length; k++) {
            const [t, sep, url, header] = draws[k]!;
            const value = t + sep + url;
            if (header && /[\r\n\f]/.test(value)) continue;
            current = { value, header };
            // What Chromium does with the page at `pagePath`.
            const observe = async (pagePath: string): Promise<string> => {
                hits.length = 0;
                const page = await ctx.newPage();
                await page.goto(`http://a.localhost:${port}${pagePath}`).catch(() => undefined);
                await page.waitForTimeout(700);
                await page.close();
                const next = hits.slice(1);
                return next.length === 0 ? "none" : next[0] === pagePath ? "reload" : next[0]!;
            };
            const pagePath = `/p/${k}?q=1`;
            let got = await observe(pagePath);
            const spec = (await oracle.ask("refreshread", [value]))!;
            let want = spec;
            if (spec.startsWith("url\t")) {
                const u = spec.slice(4);
                let r: URL | null = null;
                try { r = new URL(u, `http://a.localhost:${port}${pagePath}`); } catch { r = null; }
                // A URL that differs from the page's by its fragment only is a
                // same-document navigation: no request.
                want = r === null ? "none" : r.host !== `a.localhost:${port}` ? "elsewhere"
                    : r.pathname + r.search === pagePath ? (r.hash !== "" ? "none" : "reload") : r.pathname + r.search;
            }
            const norm = (g: string) => g !== "none" && g !== "reload" && !g.startsWith("/") ? "elsewhere" : g;
            const agrees = (g: string) => norm(g) === want || (want === "elsewhere" && norm(g) === "none");
            // Under load a page is now and then requested twice: a
            // disagreement is observed once more (the same path) before it counts.
            if (!agrees(got)) got = await observe(pagePath);
            if (!agrees(got)) bad.push(`${header ? "header" : "meta"} ${JSON.stringify(value)}: Chromium ${got}, spec ${want}`);
        }
        expect(bad.slice(0, 12), `${bad.length} differ (seed ${seed})`).toEqual([]);
    }, 300_000);
});
