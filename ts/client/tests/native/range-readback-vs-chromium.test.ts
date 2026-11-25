// @vitest-environment node
//
// A Range's contents read back as the page wrote them, in real Chromium,
// direct and through the runtime (round I: a copy handler's
// getSelection().getRangeAt(0).cloneContents() — and extractContents —
// serialized the proxified URLs). Whole, partial and extracted ranges.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Req = { url(): string };
type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

// 1x1 transparent GIF.
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const SCRIPT = `
const out = {};
const d = document.createElement("div");
d.innerHTML = '<p><a href="/rel?s1">x</a> and <img src="https://cdn.example/i.gif"></p><div style="background:url(/b.gif)">y</div><p>tail <a href="https://cdn.example/t">t</a></p>';
document.body.append(d);
const ser = (f) => { const t = document.createElement("div"); t.append(f); return t.innerHTML; };
let r = document.createRange(); r.selectNodeContents(d); out.whole = ser(r.cloneContents());
r = document.createRange(); r.setStart(d.querySelector("a").firstChild, 0); r.setEnd(d.lastChild.firstChild, 2); out.partial = ser(r.cloneContents());
out.attrs = [...r.cloneContents().querySelectorAll("[href],[src]")].map((e) => e.getAttribute("href") ?? e.getAttribute("src")).join(" ");
const e2 = document.createElement("div"); e2.innerHTML = '<span><a href="/x?e">e</a></span><b><img src="/y.gif"></b>'; document.body.append(e2);
r = document.createRange(); r.setStart(e2.firstChild, 0); r.setEnd(e2.lastChild, 1); out.extracted = ser(r.extractContents()); out.left = e2.innerHTML;
window.out = out;
`;

describe.skipIf(!wanted)("a range's contents, in Chromium, through the runtime", () => {
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
            if (u === "/direct" || u.startsWith("/cyrano/https/site.example/page")) {
                const boot = u === "/direct" ? "" : `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/page");</script>`;
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(`<!doctype html><html><head>${boot}</head><body><script>${SCRIPT}</script></body></html>`);
            }
            if (/\.gif$/.test(u)) {
                res.writeHead(200, { "content-type": "image/gif" });
                return res.end(GIF);
            }
            res.writeHead(404);
            return res.end();
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch({ args: [`--host-resolver-rules=MAP cdn.example 127.0.0.1:${new URL(origin).port}`] });
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const run = async (path: string): Promise<{ out: unknown; fetched: string[] }> => {
        const page = await browser.newPage();
        const fetched: string[] = [];
        page.on("request", (r) => { const u = r.url(); if (/\.gif$/.test(u)) fetched.push(u); });
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 500)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return { out, fetched: fetched.sort() };
    };

    it("reads back as written", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/page");
        expect((direct.out as { whole: string }).whole).toContain('href="/rel?s1"');
        expect(proxied.out).toEqual(direct.out);
    });
});
