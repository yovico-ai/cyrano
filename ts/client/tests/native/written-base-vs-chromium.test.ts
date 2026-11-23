// @vitest-environment node
//
// A <base href> in markup written into an empty frame, in real Chromium,
// direct and proxied (ginifab.com's Flashtalking richloads, 2026-11-23: the
// written document's scripts and styles were fetched from the creator's
// folder — "init is not defined"). The first <base href> is the base of
// what follows it in the same write: every URL resolves against it, as
// directly, and reads back so.
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
const f = document.createElement("iframe"); document.body.append(f);
const d = f.contentDocument; d.open();
d.write('<!DOCTYPE html><html><head><base href="http://cdn.example/rl/sub/index.html"><link rel="stylesheet" href="css/a.css"></head><body><img src="img/b.gif"><script src="scripts/i.js"><\\/script></body></html>');
d.close();
setTimeout(() => { window.out = { link: d.querySelector("link").href, img: d.querySelector("img").src, script: d.querySelector("script").src }; }, 1500);
`;

describe.skipIf(!wanted)("a <base href> written into an empty frame, in Chromium", () => {
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
            if (/\.(css|gif|js)$/.test(u)) {
                seen.push(`${req.headers.host?.startsWith("cdn.example") ? "DIRECT " : "proxied "}${u.replace(/^.*?(\/rl\/|\/cyrano\/https?(?:![a-z-]+)*\/[^/]+\/)/, "/").replace(/^\/rl\//, "/")}`);
                const t = u.endsWith(".css") ? "text/css" : u.endsWith(".gif") ? "image/gif" : "text/javascript";
                res.writeHead(200, { "content-type": t });
                return res.end("");
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
        await page.evaluate(() => new Promise((res) => setTimeout(res, 2500)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return { out, seen: [...seen].sort() };
    };

    it("resolves against the written base, as direct", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/page");
        expect(direct.out).toEqual({ link: "http://cdn.example/rl/sub/css/a.css", img: "http://cdn.example/rl/sub/img/b.gif", script: "http://cdn.example/rl/sub/scripts/i.js" });
        expect(proxied.out).toEqual(direct.out);
        expect(direct.seen).toEqual(["DIRECT /sub/css/a.css", "DIRECT /sub/img/b.gif", "DIRECT /sub/scripts/i.js"]);
        expect(proxied.seen).toEqual(direct.seen.map((s) => s.replace("DIRECT", "proxied")));
    });
});
