// @vitest-environment node
//
// A Document Picture-in-Picture window, in real Chromium, direct and
// proxied (round J: the window requestWindow() opens had no runtime — what
// the page put in it and its fetch went to their origins, its origin was
// the proxy's). It gets the opener's runtime before the page has it.
// Needs a user activation (a click) and, likely, HEADED=1.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void>; click(s: string): Promise<void>; on(e: "request", f: (r: { url(): string }) => void): void; context(): { on(e: "request", f: (r: { url(): string }) => void): void } };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const SCRIPT = `
window.out = null;
const b = document.createElement("button"); b.id = "go"; b.textContent = "pip"; document.body.append(b);
b.onclick = async () => {
  try {
    const w = await documentPictureInPicture.requestWindow({ width: 200, height: 200 });
    const i = w.document.createElement("img"); i.src = "https://img.example/p.png?k=pip1"; w.document.body.append(i);
    w.document.body.insertAdjacentHTML("beforeend", '<img src="https://img.example/p.png?k=pip2">');
    out = { origin: w.origin === window.origin };
  } catch (e) { out = e.name + ": " + e.message; }
};
`;

describe.skipIf(!wanted)("a Picture-in-Picture window, in Chromium", () => {
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
        browser = await chromium.launch({ headless: process.env.HEADED !== "1", args: ["--mute-audio"] });
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const run = async (path: string): Promise<{ out: unknown; asked: string[] }> => {
        const page = await browser.newPage();
        const asked: string[] = [];
        page.context().on("request", (r) => { const m = /img\.example\/p\.png\?k=(\w+)/.exec(r.url()); if (m) asked.push((r.url().startsWith(origin) ? "proxy " : "OUT ") + m[1]); });
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 300)));
        await page.click("#go");
        await page.evaluate(() => new Promise((res) => setTimeout(res, 1500)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return { out, asked: [...new Set(asked)].sort() };
    };

    it("gets the runtime: what goes in it loads through the proxy", async () => {
        const direct = await run("/a/direct");
        if (typeof direct.out === "string") return; // no Picture-in-Picture in this browser
        const proxied = await run("/cyrano/https/site.example/a/page");
        expect(direct.out).toEqual({ origin: true });
        expect(proxied.out).toEqual(direct.out);
        expect(proxied.asked).toEqual(["proxy pip1", "proxy pip2"]);
    }, 30_000);
});
