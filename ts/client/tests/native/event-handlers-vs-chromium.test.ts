// @vitest-environment node
//
// Event handler attributes (onload, onclick, …: spec/Attrs.agda handler),
// in real Chromium, direct and proxied. Their value is a function body the
// browser compiles; it was not rewritten in either runtime, so its
// `location` was the proxy's. A Lijit sync frame's
// `<body onload="q(location,document)">` built a script URL from the
// proxy's host (birdies.com); Basis' sync tag writes
// `<body onload="window.location.href='…'">` into a javascript: frame and
// the frame navigated to the origin, outside the proxy (guns.com). The
// handler must read the page's location, navigate through the proxy, and
// read back (getAttribute, the handler's toString) as written.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isHandlerAttr } from "../../src/patches/url-attribute-map";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Req = { url(): string; frame(): { url(): string } };
type Page = { goto(u: string): Promise<unknown>; waitForFunction(f: string, a?: unknown, o?: object): Promise<unknown>; evaluate<T, A = unknown>(f: (a: A) => T, a?: A): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const SCRIPT = `
window.r = {};
// Markup a script sets: an image's onerror reads location.
const d = document.createElement("div");
d.innerHTML = '<img src="/missing.png" onerror="window.r.markup = location.href">';
document.body.appendChild(d);
// setAttribute, then a click.
const b = document.createElement("button");
b.setAttribute("onclick", "window.r.clicked = location.host + '|' + document.location.pathname");
document.body.appendChild(b);
b.click();
window.r.attr = b.getAttribute("onclick");
window.r.source = String(b.onclick);
// Basis' sync tag: a written javascript: frame navigates itself from its onload.
const f = document.createElement("iframe");
f.src = "javascript:false";
document.body.appendChild(f);
const o = f.contentWindow.document;
o.open().write('<body onload="window.location.href=\\'http://cdn.example/sync\\'">');
o.close();
`;

describe.skipIf(!wanted)("event handler attributes, in Chromium", () => {
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
            if (/\/sync$/.test(u)) {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end("<!doctype html><p>synced</p>");
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

    const run = async (path: string): Promise<{ r: Record<string, string>; sync: string[] }> => {
        const page = await browser.newPage();
        const sync: string[] = [];
        page.on("request", (q) => { if (/\/sync$/.test(q.url())) sync.push(q.url()); });
        await page.goto(origin + path);
        await page.waitForFunction("window.r && window.r.markup !== undefined", undefined, { timeout: 5000 }).catch(() => {});
        await page.evaluate(() => new Promise((res) => setTimeout(res, 500)));
        const r = await page.evaluate(() => (window as unknown as { r: Record<string, string> }).r);
        await page.close();
        return { r, sync };
    };

    it("reads the page's location, navigates through the proxy, reads back as written", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/page");
        const host = new URL(origin).host;
        expect(direct.r).toEqual({
            markup: origin + "/direct",
            clicked: `${host}|/direct`,
            attr: "window.r.clicked = location.host + '|' + document.location.pathname",
            source: "function onclick(event) {\nwindow.r.clicked = location.host + '|' + document.location.pathname\n}",
        });
        expect(direct.sync).toEqual(["http://cdn.example/sync"]);
        expect(proxied.r).toEqual({ ...direct.r, markup: "https://site.example/page", clicked: "site.example|/page" });
        expect(proxied.sync).toEqual([`${origin}/cyrano/http/cdn.example/sync`]);
    });

    it("every name Chromium compiles as a handler is one to the rule", async () => {
        const page = await browser.newPage();
        await page.goto(origin + "/direct");
        const names = ["onclick", "onload", "onerror", "onpointerrawupdate", "onbeforematch", "onfoo", "onanimationend", "onwebkitanimationend", "onauxclick", "onscrollend", "oncontentvisibilityautostatechange", "onx", "on", "o"];
        const compiled = await page.evaluate((ns: string[]) => ns.filter((n) => {
            const els = [document.createElement("div"), document.createElementNS("http://www.w3.org/2000/svg", "rect"), document.body];
            return els.some((el) => { el.setAttribute(n, "1"); const v = (el as unknown as Record<string, unknown>)[n]; el.removeAttribute(n); return typeof v === "function"; });
        }), names);
        await page.close();
        expect(compiled.length).toBeGreaterThan(5);
        for (const n of compiled) expect(isHandlerAttr(n), n).toBe(true);
        expect(isHandlerAttr("on")).toBe(false);
        expect(isHandlerAttr("onClick")).toBe(false); // (HTML lowercases it first)
    });
});
