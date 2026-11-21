// @vitest-environment node
//
// CSS put into a <style> as text, by every route DOM gives, in real
// Chromium, direct and proxied: its url()s are fetched through the proxy,
// and the page reads its text back as it wrote it. Marketo's forms build
// the form's CSS as a text node in a DocumentFragment and append the
// fragment to a <style>: the runtime rewrote a text node appended directly
// and missed it, and the images were fetched from the origin
// (scorpion.co, 2026-11-21). append/prepend/replaceChildren/after with
// strings had no rewrite at all.
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
type Page = { goto(u: string): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const SCRIPT = `
const css = (n) => ".b" + n + "{background-image:url(https://img.example/" + n + ".png)}";
const mk = () => { const s = document.createElement("style"); return s; };
const add = (s) => { document.head.appendChild(s); return s; };
const out = [];
// 1. Marketo: a fragment holding a text node
let s = mk(); const f = document.createDocumentFragment(); f.appendChild(document.createTextNode(css(1))); s.appendChild(f); out.push(add(s));
// 2. append(string)
s = mk(); s.append(css(2)); out.push(add(s));
// 3. append(text node)
s = add(mk()); s.append(document.createTextNode(css(3))); out.push(s);
// 4. prepend(string)
s = mk(); s.prepend(css(4)); out.push(add(s));
// 5. replaceChildren(string)
s = add(mk()); s.textContent = "x{}"; s.replaceChildren(css(5)); out.push(s);
// 6. after(string) on the style's own text node
s = mk(); s.appendChild(document.createTextNode("y{}")); s.firstChild.after(css(6)); out.push(add(s));
// 7. insertBefore(fragment)
s = mk(); const g = document.createDocumentFragment(); g.appendChild(document.createTextNode(css(7))); s.insertBefore(g, null); out.push(add(s));
for (let n = 1; n <= 7; n++) { const d = document.createElement("div"); d.className = "b" + n; d.textContent = "x"; document.body.appendChild(d); }
window.texts = out.map((e) => e.textContent);
`;

const PAGE = (boot: string): string => `<!doctype html><html><head>${boot}</head><body><script>${SCRIPT}</script></body></html>`;

describe.skipIf(!wanted)("CSS text put into a <style>, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            if (u === "/direct") {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(PAGE(""));
            }
            if (u.startsWith("/cyrano/https/site.example/page")) {
                const boot = `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/page");</script>`;
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(PAGE(boot));
            }
            res.writeHead(204);
            return res.end();
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch({ args: ["--host-resolver-rules=MAP img.example 127.0.0.1"] });
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const run = async (path: string): Promise<{ texts: string[]; fetched: string[] }> => {
        const page = await browser.newPage();
        const fetched: string[] = [];
        page.on("request", (r) => { const u = r.url(); if (/img\.example/.test(u)) fetched.push(u); });
        await page.goto(origin + path);
        await page.waitForTimeout(700);
        const texts = await page.evaluate(() => (window as unknown as { texts: string[] }).texts);
        await page.close();
        return { texts, fetched };
    };

    it("fetches every image through the proxy and reads the text back as written", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/page");
        const names = (xs: string[]): string[] => xs.map((u) => u.replace(/^.*img\.example\//, "")).sort();
        expect(names(direct.fetched)).toEqual(["1.png", "2.png", "3.png", "4.png", "5.png", "6.png", "7.png"]);
        expect(names(proxied.fetched)).toEqual(names(direct.fetched));
        expect(proxied.fetched.filter((u) => !u.startsWith(origin))).toEqual([]);
        expect(proxied.texts).toEqual(direct.texts);
    });
});
