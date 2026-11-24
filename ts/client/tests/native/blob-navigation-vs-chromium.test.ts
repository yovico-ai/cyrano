// @vitest-environment node
//
// A blob: URL of an HTML document anywhere but an iframe, in real Chromium,
// direct and proxied (round J: <object data>, <embed src>, window.open and
// a top-level location set loaded its markup unrewritten, with no runtime —
// its images went to their origins). Now each gets the rewritten copy, as
// an iframe does (spec/Frames.agda blobDocument; the navigation net).
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void>; on(e: "request", f: (r: { url(): string }) => void): void; context(): { on(e: "request", f: (r: { url(): string }) => void): void } };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const SCRIPT = `
const mk = (n) => URL.createObjectURL(new Blob(['<!doctype html><body><img src="https://img.example/p.png?k=' + n + '">'], { type: "text/html" }));
const o = document.createElement("object"); o.type = "text/html"; o.data = mk("obj"); document.body.append(o);
const e = document.createElement("embed"); e.type = "text/html"; e.src = mk("emb"); document.body.append(e);
window.open(mk("win"));
setTimeout(() => { location.href = mk("top"); }, 600);
`;

describe.skipIf(!wanted)("blob: documents outside iframes, in Chromium", () => {
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
        page.context().on("request", (r) => { const m = /img\.example\/p\.png\?k=(\w+)/.exec(r.url()); if (m) asked.push((r.url().startsWith(origin) ? "proxy " : "OUT ") + m[1]); });
        await page.goto(origin + path);
        await new Promise((res) => setTimeout(res, 2500));
        const out = null;
        await page.close();
        return { out, asked: [...new Set(asked)].sort() };
    };

    it("load each through the proxy", async () => {
        const direct = await run("/a/direct");
        const proxied = await run("/cyrano/https/site.example/a/page");
        expect(direct.asked).toEqual(["OUT emb", "OUT obj", "OUT top", "OUT win"]);
        expect(proxied.asked).toEqual(["proxy emb", "proxy obj", "proxy top", "proxy win"]);
    }, 30_000);
});
