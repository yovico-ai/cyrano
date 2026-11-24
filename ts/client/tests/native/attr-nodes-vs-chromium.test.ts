// @vitest-environment node
//
// An attached Attr written through the node, and the editing commands that
// load what they insert, in real Chromium, proxied (round H probe: the
// images went to their origin). `attributes.src.value`, an Attr's
// nodeValue / textContent, execCommand insertImage / insertHTML: every image
// is asked of the proxy, none of the origin; the Attr reads back what the
// page wrote, as directly.
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
const img = (k) => { const i = document.createElement("img"); i.src = "/x.gif"; document.body.append(i); return i; };
const a = img(); a.attributes.src.value = u(1);
const b = img(); b.getAttributeNode("src").nodeValue = u(2);
const c = img(); c.getAttributeNode("src").textContent = u(3);
const ed = document.createElement("div"); ed.contentEditable = "true"; document.body.append(ed); ed.focus();
document.execCommand("insertImage", false, u(4));
document.execCommand("insertHTML", false, '<img src="' + u(5) + '">');
window.out = { value: a.attributes.src.value, nodeValue: b.getAttributeNode("src").nodeValue, text: c.attributes.src.textContent, get: a.getAttribute("src") };
`;

describe.skipIf(!wanted)("Attr writes and editing commands, in Chromium", () => {
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
        expect(direct.asked).toEqual(["OUT 1", "OUT 2", "OUT 3", "OUT 4", "OUT 5"]);
        expect(proxied.asked).toEqual(["proxy 1", "proxy 2", "proxy 3", "proxy 4", "proxy 5"]);
        expect(proxied.out).toEqual(direct.out);
    });
});
