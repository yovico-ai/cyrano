// @vitest-environment node
//
// WebSocket#url, in real Chromium, direct and proxied (toutiao.com,
// 2026-11-23: it read wss://<proxy>/cyrano/https/… back). The browser makes
// an http(s) URL ws(s); the page reads its own URL so made, as directly.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const SCRIPT = `
const out = {};
for (const [k, s] of [["space", "Create WebSocket"], ["escaped", "x%20y"], ["absolute", "wss://ws.example/raw/a%20b?q=%41"]]) {
  try { const w = new WebSocket(s); out[k] = w.url.split(location.host).join("SELF"); w.close(); } catch (e) { out[k] = e.name; }
}
window.out = out;
`;

describe.skipIf(!wanted)("WebSocket#url, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u.startsWith("/rewriter.js")) {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            if (u.startsWith("/a/direct") || u.startsWith("/cyrano/https/site.example/a/page")) {
                const boot = u.startsWith("/a/direct") ? "" : `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/a/page");</script>`;
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(`<!doctype html><html><head>${boot}</head><body><script>const s = document.createElement("script"); s.text = ${JSON.stringify(SCRIPT).replace(/</g, "\\u003c")}; document.body.appendChild(s);</script></body></html>`);
            }
            res.writeHead(404);
            return res.end();
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const run = async (path: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 300)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return out;
    };

    it("reads the page's URL, as direct", async () => {
        const direct = await run("/a/direct");
        const proxied = await run("/cyrano/https/site.example/a/page");
        // Direct the page is http (ws:); proxied its URL is https (wss:): compared by path.
        const norm = (o: unknown): unknown => JSON.parse(JSON.stringify(o).replace(/wss?:\/\/SELF/g, "ORIGIN"));
        expect(direct).toEqual({ space: "ws://SELF/a/Create%20WebSocket", escaped: "ws://SELF/a/x%20y", absolute: "wss://ws.example/raw/a%20b?q=%41" });
        expect(norm(proxied)).toEqual(norm(direct));
    });
});
