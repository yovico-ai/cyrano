// @vitest-environment node
//
// currentSrc — an image's chosen candidate (src, srcset, <picture>), a
// media element's chosen source (src, <source>) — in real Chromium, direct
// and proxied. It is no attribute: the browser resolves it from the
// proxified ones, and read the proxy's URL on every page
// (halespropertymanagement.com, 2026-11-22). It must read as direct.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; waitForFunction(f: string, a?: unknown, o?: object): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

// 1x1 transparent GIF.
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const SCRIPT = `
const add = (h) => { const d = document.createElement("div"); d.innerHTML = h; document.body.appendChild(d); return d.firstChild; };
window.els = {
  plain: add('<img src="http://cdn.example/a.gif">'),
  rel: add('<img src="rel.gif">'),
  set: add('<img srcset="http://cdn.example/s1.gif 1x, http://cdn.example/s2.gif 2x">'),
  pic: add('<picture><source srcset="http://cdn.example/p.gif"><img src="http://cdn.example/fallback.gif"></picture>').querySelector("img"),
  idl: (() => { const i = new Image(); i.src = "http://cdn.example/idl.gif"; document.body.appendChild(i); return i; })(),
  none: add('<img alt="x">'),
  video: add('<video preload="auto" src="http://cdn.example/v.webm"></video>'),
  audio: add('<audio preload="auto"><source src="http://cdn.example/s.ogg" type="audio/ogg"></audio>'),
};
`;

describe.skipIf(!wanted)("currentSrc, in Chromium", () => {
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
            if (u === "/direct" || u.startsWith("/cyrano/https/site.example/dir/page")) {
                const boot = u === "/direct" ? "" : `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/dir/page");</script>`;
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

    const run = async (path: string): Promise<Record<string, string>> => {
        const page = await browser.newPage();
        await page.goto(origin + path);
        await page.waitForFunction("Object.values(window.els).every(function (e) { return e.complete !== false && (e.readyState === undefined || e.networkState !== 2); })", undefined, { timeout: 5000 }).catch(() => {});
        const got = await page.evaluate(() => {
            const out: Record<string, string> = {};
            const els = (window as unknown as { els: Record<string, HTMLImageElement | HTMLMediaElement> }).els;
            for (const k of Object.keys(els)) out[k] = els[k]!.currentSrc;
            return out;
        });
        await page.close();
        return got;
    };

    it("reads the page's URL, as direct", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/dir/page");
        // Direct, relative URLs resolve against the test server; proxied, against the page's URL.
        const norm = (r: Record<string, string>): Record<string, string> => {
            const o: Record<string, string> = {};
            for (const [k, v] of Object.entries(r)) o[k] = v.replace(origin + "/", "https://site.example/dir/");
            return o;
        };
        expect(direct.plain).toBe("http://cdn.example/a.gif");
        expect(direct.pic).toBe("http://cdn.example/p.gif");
        expect(direct.none).toBe("");
        expect(norm(proxied)).toEqual(norm(direct));
    });
});
