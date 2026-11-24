// @vitest-environment node
//
// The drag data store, in real Chromium, direct and proxied (round J: a
// link or image dragged onto a drop zone gave the page proxified URLs in
// text/uri-list, text/plain and text/html). Each reads as directly, URLs
// relative to the page's origin.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void>; on(e: "request", f: (r: { url(): string }) => void): void; dragAndDrop(a: string, b: string): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const SCRIPT = `
window.out = [];
const a = document.createElement("a"); a.id = "l"; a.href = "/p?dnd"; a.textContent = "link"; a.style.cssText = "display:block;width:80px;height:30px";
const im = document.createElement("img"); im.id = "m"; im.src = "/lg.gif?dndimg"; im.width = 30; im.height = 30;
const z = document.createElement("div"); z.id = "z"; z.style.cssText = "width:200px;height:100px;background:#ccc";
z.addEventListener("dragover", (e) => e.preventDefault());
const rel = (s) => String(s).split(location.origin).join("O");
z.addEventListener("drop", (e) => { e.preventDefault(); const h = rel(e.dataTransfer.getData("text/html")); out.push(["text/uri-list", "text/plain"].map((t) => rel(e.dataTransfer.getData(t))).join(" | ") + " | " + (h.includes('href="O/p?dnd"') || h.includes('src="O/lg.gif?dndimg"') ? "html ok" : "html " + h.slice(0, 120))); });
document.body.append(a, im, z);
`;

describe.skipIf(!wanted)("the drag data store, in Chromium", () => {
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
            if (u.includes("lg.gif")) {
                res.writeHead(200, { "content-type": "image/gif" });
                return res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
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
        await page.evaluate(() => new Promise((res) => setTimeout(res, 300)));
        for (const sel of ["#l", "#m"]) {
            await page.dragAndDrop(sel, "#z");
        }
        await page.evaluate(() => new Promise((res) => setTimeout(res, 300)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return { out, asked: [...new Set(asked)].sort() };
    };

    it("reads the page's URLs, as directly", async () => {
        const direct = await run("/a/direct");
        const proxied = await run("/cyrano/https/site.example/a/page");
        expect(direct.out).toEqual(["O/p?dnd | O/p?dnd | html ok", "O/lg.gif?dndimg |  | html ok"]);
        expect(proxied.out).toEqual(direct.out);
    });
});
