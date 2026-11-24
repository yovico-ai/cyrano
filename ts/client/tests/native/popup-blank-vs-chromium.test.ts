// @vitest-environment node
//
// A popup opened on about:blank, in real Chromium, through the runtime
// (round H: the usual OAuth / payment popup — opened in the click, written
// into or sent somewhere later). It gets its opener's runtime, as an empty
// frame does its creator's: what the page writes into it and where it sends
// it go through the proxy, its document.cookie is the opener's cookies (no
// channel entry shows), its origin the page's.
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
type Req = { url(): string };
type Context = { newPage(): Promise<Page>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };

const SCRIPT = `
(async () => {
const out = {};
document.cookie = "op=1; path=/";
const w = window.open("");
const i = w.document.createElement("img"); i.src = "https://other.example/written.png"; w.document.body.append(i);
w.document.cookie = "fromPopup=1; path=/";
out.popupCookie = w.document.cookie.split("; ").sort().join("; ");
out.openerCookie = document.cookie.split("; ").sort().join("; ");
out.origin = w.origin === window.origin;
const n1 = window.open("about:blank", "nm");
n1.location = "https://other.example/assigned";
const n2 = window.open("", "nm2");
n2.location.href = "https://other.example/href";
window.out = out;
})();
`;

describe.skipIf(!wanted)("a popup opened on about:blank, in Chromium, through the runtime", () => {
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

    it("goes through the proxy, with the opener's cookies and origin", async () => {
        const ctx = await browser.newContext();
        const outside: string[] = [];
        ctx.on("request", (r) => { const u = r.url(); if (/^https?:/.test(u) && !u.startsWith(origin)) outside.push(u); });
        const page = await ctx.newPage();
        await page.goto(origin + "/cyrano/https/site.example/a/page");
        await page.evaluate(() => new Promise((res) => setTimeout(res, 1500)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await ctx.close();
        expect(out).toEqual({ popupCookie: "fromPopup=1; op=1", openerCookie: "fromPopup=1; op=1", origin: true });
        expect(outside).toEqual([]);
    }, 60_000);
});
