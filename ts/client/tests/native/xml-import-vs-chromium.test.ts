// @vitest-environment node
//
// A tree parsed by DOMParser as XML (image/svg+xml, application/xhtml+xml,
// text/xml) and handed to the page by importNode / adoptNode, in real
// Chromium, direct and proxied (round I/J: its <image href>, <use href>,
// xlink:href, fill="url(…)", <style>@import, an XHTML <img>, <link>, a style
// attribute's url() loaded from their origins — the nodes were the page
// document's before insertion, so the fix-up took them for its own). SVG
// icon loaders fetch an .svg, parse it so and import it. Every request
// goes through the proxy; the page reads back what it wrote.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void>; on(e: "request", f: (r: { url(): string }) => void): void };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const SCRIPT = `
const I = (k) => "https://img.example/p.png?k=" + k;
const svg = (k) => '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient id="g"/></defs>' +
  '<image href="' + I(k + "href") + '" width="1" height="1"/><image xlink:href="' + I(k + "xlink") + '" width="1" height="1"/>' +
  '<use href="' + I(k + "use") + '#a"/><rect width="1" height="1" fill="url(' + I(k + "fill") + '#g)"/>' +
  '<style>@import url(' + I(k + "import") + ');</style></svg>';
const p = new DOMParser();
const a = p.parseFromString(svg("i"), "image/svg+xml");
document.body.append(document.importNode(a.documentElement, true));
const b = p.parseFromString(svg("a"), "image/svg+xml");
document.body.append(document.adoptNode(b.documentElement));
const x = p.parseFromString('<div xmlns="http://www.w3.org/1999/xhtml"><img src="' + I("ximg") + '"/><link rel="stylesheet" href="' + I("xcss") + '"/>' +
  '<span style="display:block;width:2px;height:2px;background:url(' + I("xspan") + ')"></span></div>', "application/xhtml+xml");
document.body.append(document.importNode(x.documentElement, true));
const t = p.parseFromString('<svg xmlns="http://www.w3.org/2000/svg"><image href="' + I("tadopt") + '" width="1" height="1"/></svg>', "text/xml");
const one = document.importNode(t.documentElement, true).firstChild;
document.body.append(document.createElementNS("http://www.w3.org/2000/svg", "svg")); document.body.lastChild.append(one);
window.out = { href: document.querySelector("image").getAttribute("href"), style: document.querySelector("style").textContent };
`;

describe.skipIf(!wanted)("XML trees imported or adopted, in Chromium", () => {
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
                const boot = u.startsWith("/a/direct") ? "" : `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js",toolbar:false}).inject();$rewriter.set_location("https://site.example/a/page");</script>`;
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

    const run = async (path: string): Promise<{ out: unknown; asked: string[] }> => {
        const page = await browser.newPage();
        const asked: string[] = [];
        page.on("request", (r) => { const m = /img\.example\/p\.png\?k=(\w+)/.exec(r.url()); if (m) asked.push((r.url().startsWith(origin) ? "proxy " : "OUT ") + m[1]); });
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 800)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return { out, asked: [...new Set(asked)].sort() };
    };

    it("load every URL through the proxy, and read back as written", async () => {
        const direct = await run("/a/direct");
        const proxied = await run("/cyrano/https/site.example/a/page");
        const all = ["aimport", "ahref", "ause", "afill", "axlink", "iimport", "ihref", "iuse", "ifill", "ixlink", "tadopt", "ximg", "xcss", "xspan"];
        expect(direct.asked.map((x) => x.split(" ")[1]).sort()).toEqual([...all].sort());
        expect(proxied.asked).toEqual(direct.asked.map((x) => "proxy " + x.split(" ")[1]));
        expect(proxied.out).toEqual(direct.out);
    });
});
