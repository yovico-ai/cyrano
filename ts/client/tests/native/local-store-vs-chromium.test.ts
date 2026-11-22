// @vitest-environment node
//
// localStorage per original origin, each with its own quota
// (spec/LocalStore.agda), in real Chromium, direct and proxied. Every
// proxied site really lives on the proxy's origin, so they shared one
// quota: sports-reference.com's caches threw QuotaExceededError through
// the proxy and not directly (2026-11-21). Now:
//   * two sites each store nearly a quota's worth, as directly;
//   * a site that passes its own quota gets QuotaExceededError, as directly;
//   * a site whose entries the other pushed out of the native store finds
//     them all again on its next load (from IndexedDB).
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

const BIG = 4 * 1024 * 1024; // characters: under one quota, over half of it

describe.skipIf(!wanted)("localStorage, each site its own quota, in Chromium", () => {
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

    // Stores n characters under key k; reports how it went.
    const store = (page: Page, k: string, n: number): Promise<string> => page.evaluate(([k, n]) => {
        try { localStorage.setItem(k, "x".repeat(n)); return "ok"; } catch (e) { return (e as Error).name; }
    }, [k, n] as [string, number]);
    // The length of key k's value, waiting up to 3 s for it to appear.
    const lengthOf = (page: Page, k: string): Promise<number> => page.evaluate(async (k) => {
        for (let i = 0; i < 30; i++) {
            const v = localStorage.getItem(k);
            if (v !== null) return v.length;
            await new Promise((r) => setTimeout(r, 100));
        }
        return -1;
    }, k);

    const run = async (a: string, b: string): Promise<Record<string, unknown>> => {
        const ctx = await browser.newContext();
        const pa = await ctx.newPage(); await pa.goto(a);
        const pb = await ctx.newPage(); await pb.goto(b);
        const out: Record<string, unknown> = {};
        out["a stores 4M"] = await store(pa, "data", BIG);
        out["b stores 4M"] = await store(pb, "data", BIG);
        out["a passes its quota"] = await store(pa, "more", 2 * 1024 * 1024);
        out["a still holds"] = await lengthOf(pa, "data");
        await pa.close(); await pb.close();
        // A fresh load of a: its entry, whatever the native store kept.
        const pa2 = await ctx.newPage(); await pa2.goto(a);
        out["a after reload"] = await lengthOf(pa2, "data");
        out["a's length"] = await pa2.evaluate(() => localStorage.length, null);
        await ctx.close();
        return out;
    };

    it("gives each site its own quota and keeps every entry, as direct", async () => {
        const direct = await run(`http://127.0.0.1:${port}/page`, `http://localhost:${port}/page`);
        const proxied = await run(`http://127.0.0.1:${port}/cyrano/https/a.example/page`, `http://127.0.0.1:${port}/cyrano/https/b.example/page`);
        expect(direct).toEqual({ "a stores 4M": "ok", "b stores 4M": "ok", "a passes its quota": "QuotaExceededError", "a still holds": BIG, "a after reload": BIG, "a's length": 1 });
        expect(proxied).toEqual(direct);
    }, 120_000);
});
