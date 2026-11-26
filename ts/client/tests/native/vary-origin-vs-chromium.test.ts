// @vitest-environment node
//
// A response that varies on Origin, cached by the browser, in real
// Chromium, direct and proxied. Natively the cache keeps a copy per
// Origin: the one a page of its own origin fetched (no CORS headers) is
// not what another origin's page gets. Through the proxy every request is
// the proxy's own and carries no Origin, so the second page was handed
// the first's copy, failed the CORS check and fell back (bbc.com's
// "Error fetching userinfo": it sent the reader back to bbc.co.uk,
// 2026-11-20).
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; waitForFunction(f: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };

// What the proxy tells the browser for "Vary: Origin" (spec/Carry.agda varyForBrowser).
const VARY_FOR_BROWSER = process.env.CRN_VARY_AS_ORIGIN === "1" ? "Origin" : "Origin, Crn-I";
const FETCH = (url: string) => `<script>fetch(${JSON.stringify(url)}).then(function (r) { return r.text(); }).then(function (t) { window.got = "ok " + t; }, function (e) { window.got = "rejects " + e.name; });</script>`;

describe.skipIf(!wanted)("a response that varies on Origin, cached, in Chromium, direct and proxied", () => {
    let browser: Browser;
    let server: Server;
    let port = 0;
    const marks: Record<string, [string, string]> = {};

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const proxy = `http://127.0.0.1:${port}`;
            const u = req.url ?? "";
            if (u === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            // a.test's resource: cacheable, its CORS answer by the request's
            // Origin. Proxied, this server plays the proxy's part: the
            // Origin upstream is the page's (from Crn-I, the runtime's
            // header), and the browser is told the Vary the proxy gives it
            // (Go: proxy/vary.go varyForBrowser — Crn-I besides Origin).
            if (u.includes("/info")) {
                const proxied = u.startsWith("/cyrano/");
                const crnI = req.headers["crn-i"];
                // (the runtime names a same-origin fetch's context too: no Origin for it, as the proxy's spec gives)
                const named = typeof crnI === "string" ? new URL(crnI).origin : undefined;
                const o = proxied ? (named && named !== `http://a.test:${port}` ? named : undefined) : req.headers.origin;
                const h: Record<string, string> = { "content-type": "text/plain", "cache-control": "max-age=300", vary: proxied ? VARY_FOR_BROWSER : "Origin" };
                if (o && o !== "null") h["access-control-allow-origin"] = o;
                res.writeHead(200, h);
                return res.end(o ? `for ${o}` : "own");
            }
            const mk = /\/mark\?k=(\w+)/.exec(u);
            if (mk) {
                marks[mk[1]!] = [String(req.headers["crn-i"]), String(req.headers["crn-c"])];
                res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
                return res.end("m");
            }
            const m = /^\/cyrano\/http\/([^/]+)(\/.*)$/.exec(u);
            const host = m ? m[1]! : (req.headers.host ?? "");
            const path = m ? m[2]! : u;
            const info = `http://a.test:${port}/info`;
            const boot = (page: string) => `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(proxy)},source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(page)});</script>`;
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return res.end(`<!doctype html>${m ? boot(`http://${host}${path}`) : ""}${FETCH(info)}`);
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch({ args: ["--host-resolver-rules=MAP *.test 127.0.0.1"] });
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    // Page of a.test, then a page of b.test, in one browser (one cache).
    const run = async (urlOf: (host: string) => string): Promise<unknown[]> => {
        const ctx = await browser.newContext();
        const out: unknown[] = [];
        for (const host of [`a.test:${port}`, `b.test:${port}`]) {
            const page = await ctx.newPage();
            await page.goto(urlOf(host));
            await page.waitForFunction("window.got !== undefined");
            out.push(await page.evaluate(() => (window as unknown as { got: unknown }).got));
            await page.close();
        }
        await ctx.close();
        return out;
    };

    it("each origin gets its own copy", async () => {
        const direct = await run((h) => `http://${h}/p`);
        const proxied = await run((h) => `http://127.0.0.1:${port}/cyrano/http/${h}/p`);
        expect(direct).toEqual(["ok own", `ok for http://b.test:${port}`]);
        expect(proxied).toEqual(direct);
    }, 30_000);

    // The runtime names a cross-origin fetch's context to the proxy
    // (patches/cors.ts): a Headers handed to the native in an init is read
    // by its iterator, which the runtime wraps to hide those headers from
    // the page — they were never sent (found with the case above).
    it("a cross-origin fetch names its context, in every form", async () => {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(`http://127.0.0.1:${port}/cyrano/http/b.test:${port}/p`);
        await page.waitForFunction("window.got !== undefined");
        await page.evaluate(() => {
            const p = location.pathname.match(/b\.test:(\d+)/)![1]!;
            const at = (k: string) => `http://a.test:${p}/mark?k=${k}`;
            return Promise.all([
                fetch(at("bare")), fetch(at("headers"), { headers: { "x-a": "1" } }), fetch(new Request(at("request"))),
                fetch(at("include"), { credentials: "include" }),
            ].map((x) => x.catch(() => undefined)));
        });
        await ctx.close();
        expect(marks).toEqual({
            // Crn-C: the page's mode as set (the proxy resolves "same-origin" per target)
            bare: [`http://b.test:${port}/p`, "same-origin"], headers: [`http://b.test:${port}/p`, "same-origin"],
            request: [`http://b.test:${port}/p`, "same-origin"], include: [`http://b.test:${port}/p`, "include"],
        });
    }, 30_000);
});
