// @vitest-environment node
//
// The Cache API, in real Chromium, direct and proxied
// (toyotaofbellevue.com, 2026-11-22: `cache.add(url)` fetched gubagoo's
// scripts from their origin). add / addAll must fetch through the proxy,
// and every lookup by the page's own URL (string, URL, Request) must find
// what was stored, keys() and responses reading the page's URLs — as
// direct. Requests are recorded by the server: what reached the origin
// directly arrives for host cdn.example.
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
(async () => {
  const u = (n) => "http://cdn.example/" + n + ".js";
  const out = {};
  const c = await caches.open("t");
  await c.add(u("added"));
  await c.addAll([u("all1"), new URL(u("all2"))]);
  await c.put(u("put"), new Response("p"));
  out.byString = !!(await c.match(u("added")));
  out.byUrl = !!(await c.match(new URL(u("all1"))));
  out.byRequest = !!(await c.match(new Request(u("all2"))));
  out.put = await (await c.match(new Request(u("put")))).text();
  out.storage = !!(await caches.match(u("added")));
  out.responseUrl = (await c.match(u("added"))).url;
  out.keys = (await c.keys()).map((r) => r.url).sort();
  out.matchAll = (await c.matchAll(u("all1"))).length;
  out.deleted = await c.delete(u("put"));
  out.gone = !(await c.match(u("put")));
  window.out = out;
})().catch((e) => { window.out = "error " + e.name + ": " + e.message; });
`;

describe.skipIf(!wanted)("the Cache API, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";
    let seen: string[] = [];

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
            if (/\.js$/.test(u)) {
                seen.push(`${req.headers.host?.startsWith("cdn.example") ? "DIRECT" : "proxied"} ${u.replace(/^.*\/([a-z0-9]+)\.js$/, "$1")}`);
                res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" });
                return res.end("//");
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

    const run = async (path: string): Promise<{ out: unknown; seen: string[] }> => {
        seen = [];
        const page = await browser.newPage();
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 1500)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return { out, seen: [...seen].sort() };
    };

    it("fetches through the proxy and finds entries by the page's URLs, as direct", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/page");
        expect(direct.seen).toEqual(["DIRECT added", "DIRECT all1", "DIRECT all2"]);
        expect(proxied.seen).toEqual(["proxied added", "proxied all1", "proxied all2"]);
        expect(proxied.out).toEqual(direct.out);
    });
});
