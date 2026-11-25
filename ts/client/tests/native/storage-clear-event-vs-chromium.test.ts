// @vitest-environment node
//
// localStorage.clear() as another tab of the site hears it, in real
// Chromium, direct and proxied (round K: one `storage` event per removed key
// reached the other tab; natively one, with key, oldValue, newValue null).
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T | Promise<T>, a: A): Promise<T>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };


describe.skipIf(!wanted)("localStorage.clear in another tab, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u.startsWith("/rewriter.js")) {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            const m = /^\/cyrano\/https\/([a-z]+\.example)\/page/.exec(u);
            const boot = m ? `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://${m[1]}/page");</script>` : "";
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return res.end(`<!doctype html><html><head>${boot}</head><body>page</body></html>`);
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const run = async (a: string): Promise<unknown> => {
        const ctx = await browser.newContext();
        const pa = await ctx.newPage(); await pa.goto(a);
        const pb = await ctx.newPage(); await pb.goto(a);
        await pb.evaluate(() => {
            (window as unknown as { heard: string[] }).heard = [];
            addEventListener("storage", (e) => (window as unknown as { heard: string[] }).heard.push([e.key, e.oldValue, e.newValue].map(String).join(" ")));
        }, null);
        // (Written in one task: the other tab hears every write — it once
        // heard the first only: its runtime wrote the store as the first
        // event came.)
        await pa.evaluate(() => { localStorage.setItem("a", "1"); localStorage.setItem("b", "2"); localStorage.setItem("c", "3"); }, null);
        await new Promise((r) => setTimeout(r, 300));
        await pa.evaluate(() => { localStorage.clear(); }, null);
        await new Promise((r) => setTimeout(r, 500));
        const heard = await pb.evaluate(() => [(window as unknown as { heard: string[] }).heard, localStorage.length], null);
        await ctx.close();
        return heard;
    };

    it("reaches another tab as one clear, as direct", async () => {
        const direct = await run(`http://127.0.0.1:${port}/a`);
        const proxied = await run(`http://127.0.0.1:${port}/cyrano/https/a.example/page`);
        expect(direct).toEqual([["a null 1", "b null 2", "c null 3", "null null null"], 0]);
        expect(proxied).toEqual(direct);
    }, 60_000);
});
