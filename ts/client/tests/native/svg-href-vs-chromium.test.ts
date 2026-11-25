// @vitest-environment node
//
// An SVG element's href written and read through its SVGAnimatedString
// (`image.href.baseVal = url`), in real Chromium, direct and proxied
// (round K's built-in survey: the image loaded from its origin; baseVal /
// animVal read the proxified URL). As Chromium reflects it (measured):
// a write sets href, or xlink:href when only that is there; a read gives
// href, else xlink:href. Loads go through the proxy, reads give what the
// page wrote, and className (another SVGAnimatedString) is untouched.
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
const S = "http://www.w3.org/2000/svg", X = "http://www.w3.org/1999/xlink";
const svg = document.createElementNS(S, "svg"); document.body.appendChild(svg);
const img = (f) => { const i = document.createElementNS(S, "image"); i.setAttribute("width", "1"); i.setAttribute("height", "1"); f(i); svg.appendChild(i); return i; };
const out = {};
let i = img((i) => { i.href.baseVal = "http://cdn.example/base.gif"; });
out.base = [i.href.baseVal, i.href.animVal, i.getAttribute("href"), i.getAttributeNS(X, "href")];
i = img((i) => { i.setAttributeNS(X, "xlink:href", "http://cdn.example/old.gif"); i.href.baseVal = "http://cdn.example/xl.gif"; });
out.xlink = [i.href.baseVal, i.getAttribute("href"), i.getAttributeNS(X, "href")];
i = img((i) => { i.href.baseVal = "img/rel.gif"; });
out.rel = [i.href.baseVal, i.href.animVal];
i = img((i) => { i.href.baseVal = { toString() { return "http://cdn.example/obj.gif"; } }; });
out.obj = i.href.baseVal;
i = img((i) => { i.setAttribute("href", "http://cdn.example/attr.gif"); });
out.attr = [i.href.baseVal, i.href.animVal];
svg.className.baseVal = "k"; out.cls = [svg.getAttribute("class"), svg.className.baseVal];
window.out = out;
`;

describe.skipIf(!wanted)("an SVG href through its SVGAnimatedString, in Chromium", () => {
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
        page.on("request", (r) => { const u = r.url(); if (/\.gif$/.test(u) && !/old\.gif/.test(u)) fetched.push(u); });
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 500)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return { out, fetched: fetched.sort() };
    };

    it("loads through the proxy and reads as directly", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/page");
        expect(direct.fetched.map((u) => u.replace(/^http:\/\/[^/]+\//, "")).sort()).toEqual(["attr.gif", "base.gif", "img/rel.gif", "obj.gif", "xl.gif"]);
        expect((direct.out as { xlink: unknown }).xlink).toEqual(["http://cdn.example/xl.gif", null, "http://cdn.example/xl.gif"]);
        expect(proxied.out).toEqual(direct.out);
        expect(proxied.fetched.every((u) => u.startsWith(origin + "/cyrano/"))).toBe(true);
        expect(proxied.fetched.length).toBe(direct.fetched.length);
    });
});
