// @vitest-environment node
//
// "The spec is the browser", for spec/Html.agda: what a <script> is
// (`scriptkind`: whether it runs, as classic or module) and the document
// base URL (`docbase`), against real Chromium.
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; waitForTimeout(ms: number): Promise<void>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void>; version(): string };

const types = ["", " ", "text/javascript", "TEXT/JAVASCRIPT", " text/javascript ", "text/javascript; charset=utf-8", "application/javascript",
    "text/javascript1.5", "text/jscript", "text/livescript", "application/x-javascript", "text/ecmascript", "module", " MODULE",
    "importmap", "speculationrules", "application/json", "text/template", "x", "javascript", "text/javascript\t"];
const languages = ["", "javascript", "JavaScript1.5", "jscript", "vbscript", "ecmascript", " javascript"];
const hrefs = ["", "/a/", "../b/", "https://other.example/c/", "//proto.example/d", "?q", "#f", "data:text/html,x", "javascript:void 0",
    "ftp://ftp.example/", "http://[::1/", "e/f"];

let html = "";

describe.skipIf(!wanted || located.skip !== "")("HTML: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((_req, res) => {
            res.writeHead(200, { "content-type": "text/html" });
            res.end(html);
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

    const load = async (body: string): Promise<Page> => {
        html = body;
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(`http://127.0.0.1:${port}/dir/page`);
        await page.waitForTimeout(150);
        return page;
    };

    it("which scripts run, and as what", async () => {
        const attr = fc.option(fc.constantFrom(...types), { nil: undefined });
        const lang = fc.option(fc.constantFrom(...languages), { nil: undefined });
        const draws = fc.sample(fc.tuple(attr, lang), { numRuns: 120, seed: Number(process.env.CYRANO_SEED ?? Date.now() % 1e9) });
        const scripts = draws.map(([t, l], i) => {
            const a = (t !== undefined ? ` type="${t}"` : "") + (l !== undefined ? ` language="${l}"` : "");
            return `<script${a}>(window.ran = window.ran || {})[${i}] = document.currentScript !== null ? "classic" : "module";</script>`;
        }).join("\n");
        const page = await load(`<!doctype html><body>${scripts}</body>`);
        const ran = await page.evaluate(() => (window as unknown as { ran?: Record<string, string> }).ran ?? {});
        await page.close();
        const mismatches: string[] = [];
        for (let i = 0; i < draws.length; i++) {
            const [t, l] = draws[i]!;
            const kind = await oracle.ask("scriptkind", [t !== undefined ? "1" : "0", t ?? "", l !== undefined ? "1" : "0", l ?? ""]);
            const want = kind === "classic" || kind === "module" ? kind : "not run";
            const got = ran[String(i)] ?? "not run";
            if (want !== got) mismatches.push(`type=${JSON.stringify(t)} language=${JSON.stringify(l)}: spec ${kind}, chromium ${got}`);
        }
        expect(mismatches.slice(0, 20), `${mismatches.length} differ (chromium ${browser.version()})`).toEqual([]);
    }, 120_000);

    it("the document base URL", async () => {
        const base = fc.record({ href: fc.option(fc.constantFrom(...hrefs), { nil: undefined }) });
        const draws = fc.sample(fc.array(base, { maxLength: 3 }), { numRuns: 60, seed: Number(process.env.CYRANO_SEED ?? Date.now() % 1e9) });
        const mismatches: string[] = [];
        for (const bases of draws) {
            const tags = bases.map((b) => (b.href !== undefined ? `<base href="${b.href}">` : `<base target="_self">`)).join("");
            const page = await load(`<!doctype html><head>${tags}</head><body></body>`);
            const got = await page.evaluate(() => document.baseURI);
            await page.close();
            const doc = `http://127.0.0.1:${port}/dir/page`;
            let want: string | null;
            try {
                want = await oracle.ask("docbase", [doc, ...bases.filter((b) => b.href !== undefined).map((b) => b.href!)]);
            } catch {
                continue; // outside the model
            }
            if (want !== got) mismatches.push(`${tags}: spec ${want}, chromium ${got}`);
        }
        expect(mismatches.slice(0, 20), `${mismatches.length} differ (chromium ${browser.version()})`).toEqual([]);
    }, 300_000);
});
