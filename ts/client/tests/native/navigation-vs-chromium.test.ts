// @vitest-environment node
//
// The Navigation API in real Chromium, on a proxied page: the URLs page code
// reads are the original ones, and navigation.navigate goes through
// containment (Shopify's exit-intent script judged every link by
// destination.url and looped through /url?q=).
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; click(sel: string): Promise<void>; waitForFunction(f: string): Promise<unknown> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

describe.skipIf(!wanted)("the Navigation API in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        const boot = (original: string) =>
            `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(original)});</script>`;
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                res.end(bundle);
                return;
            }
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            // The page's own script is not rewritten: only the native surface is in play.
            res.end(`<!doctype html><head>${boot("https://shop.example/page")}</head><body>
<a id="next" href="/cyrano/https/shop.example/next">next</a>
<script>
window.seen = { start: navigation.currentEntry.url, destinations: [] };
navigation.addEventListener("navigate", (e) => {
    window.seen.destinations.push(e.destination.url);
    if (e.canIntercept) e.intercept({ handler: async () => {} });
});
</script></body>`);
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        const addr = server.address();
        origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        const require = createRequire(resolve(__dirname, "../../../e2e/package.json"));
        const { chromium } = require("playwright") as { chromium: { launch(o: object): Promise<Browser> } };
        browser = await chromium.launch({ headless: true });
    }, 60_000);

    afterAll(async () => {
        await browser?.close();
        await new Promise<void>((r) => server?.close(() => r()));
    });

    it("shows original URLs and contains navigate()", async () => {
        const page = await browser.newPage();
        await page.goto(`${origin}/cyrano/https/shop.example/page`);
        await page.click("#next");
        await page.waitForFunction("window.seen.destinations.length === 1");
        await page.evaluate(() => (window as unknown as { navigation: { navigate(u: string): unknown } }).navigation.navigate("/other"));
        await page.waitForFunction("window.seen.destinations.length === 2");
        const out = await page.evaluate(() => {
            const w = window as unknown as { seen: { start: string; destinations: string[] } };
            const nav = (window as unknown as { navigation: { currentEntry: { url: string }; entries(): { url: string }[] } }).navigation;
            return {
                start: w.seen.start,
                destinations: w.seen.destinations,
                current: nav.currentEntry.url,
                entries: nav.entries().map((e) => e.url),
                realPath: location.pathname,
            };
        });
        expect(out).toEqual({
            start: "https://shop.example/page",
            destinations: ["https://shop.example/next", "https://shop.example/other"],
            current: "https://shop.example/other",
            entries: ["https://shop.example/page", "https://shop.example/next", "https://shop.example/other"],
            realPath: "/cyrano/https/shop.example/other",
        });
    }, 60_000);
});
