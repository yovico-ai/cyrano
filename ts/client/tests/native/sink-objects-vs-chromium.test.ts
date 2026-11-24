// @vitest-environment node
//
// Markup and CSS handed to a sink as an object, in real Chromium, proxied
// (round J: rakuten.co.jp's document.write of a non-string wrote its pixel
// unrewritten; innerHTML, insertAdjacentHTML, a constructed sheet's
// replaceSync, style.cssText / setProperty / a property, FontFace given a
// String object or anything with a toString went to the origin). The
// native reads a DOMString (ToString, once): so does the runtime, which then
// rewrites it. What document.write writes of numbers, null and undefined,
// and a Symbol's TypeError, as directly.
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
const u = (k) => "https://img.example/p.png?k=" + k;
const O = (s) => ({ toString() { return s; } });
const box = () => { const d = document.createElement("div"); document.body.append(d); return d; };
box().innerHTML = O('<img src="' + u(1) + '">');
box().innerHTML = new String('<img src="' + u(2) + '">');
box().insertAdjacentHTML("beforeend", O('<img src="' + u(3) + '">'));
document.write(O('<img src="' + u(4) + '">'), 5, null, undefined);
const sh = new CSSStyleSheet(); sh.replaceSync(O("body{background:url(" + u(5) + ")}")); document.adoptedStyleSheets = [sh];
const e6 = box(); e6.style.cssText = O("width:5px;height:5px;background:url(" + u(6) + ")");
const e7 = box(); e7.style.width = "5px"; e7.style.height = "5px"; e7.style.setProperty("background-image", O("url(" + u(7) + ")"));
const e8 = box(); e8.style.width = "5px"; e8.style.height = "5px"; e8.style.backgroundImage = O("url(" + u(8) + ")");
new FontFace("f9", O("url(" + u(9) + ")")).load().catch(() => {});
let sym = "none"; try { box().innerHTML = Symbol("x"); } catch (e) { sym = e.name; }
window.out = { text: document.body.textContent.replace(/\\s+/g, " ").trim(), sym };
`;

describe.skipIf(!wanted)("sinks given an object, in Chromium", () => {
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

    const run = async (path: string): Promise<{ out: unknown; asked: string[] }> => {
        const page = await browser.newPage();
        const asked: string[] = [];
        page.on("request", (r) => { const m = /img\.example\/p\.png\?k=(\d)/.exec(r.url()); if (m) asked.push((r.url().startsWith(origin) ? "proxy " : "OUT ") + m[1]); });
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 800)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return { out, asked: [...new Set(asked)].sort() };
    };

    it("asks the proxy for every image, as direct asks the origin", async () => {
        const direct = await run("/a/direct");
        const proxied = await run("/cyrano/https/site.example/a/page");
        const all = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
        expect(direct.asked).toEqual(all.map((k) => "OUT " + k));
        expect(proxied.asked).toEqual(all.map((k) => "proxy " + k));
        expect(proxied.out).toEqual(direct.out);
    });
});
