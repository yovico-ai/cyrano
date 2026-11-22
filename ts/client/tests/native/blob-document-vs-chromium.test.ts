// @vitest-environment node
//
// A frame given a blob: URL of an HTML document built in the browser
// (spec/Frames.agda blobDocument), in real Chromium, direct and proxied.
// TradingView's chart (bitrue.com, 2026-11-21) builds its page so; the
// document never passed the server and its bundles loaded from their
// origin. Its script and image must go through the proxy — resolved against
// the document's own <base href> — its own inline script run, and the page
// read back the URL it gave the frame.
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
type Page = { goto(u: string): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; waitForFunction(f: string, a?: unknown, o?: object): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const SCRIPT = `
const html = '<!doctype html><html><head><script src="http://cdn.example/lib.js"></scr' + 'ipt></head><body>' +
  '<img src="http://cdn.example/logo.png"><script>parent.frameRan = typeof libLoaded;</scr' + 'ipt></body></html>';
const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
const f = document.createElement("iframe");
f.src = url;
document.body.appendChild(f);
window.sameUrl = f.src === url && f.getAttribute("src") === url;
// As markup (TradingView: container.innerHTML = '<iframe src="blob:…">').
const g = document.createElement("div");
document.body.appendChild(g);
// Its own <base href>, relative URLs after it (TradingView's library_path).
const withBase = html.replace("frameRan", "markupRan").replace("<head>", '<head><base href="http://cdn.example/b/">')
  .replace("http://cdn.example/lib.js", "lib2.js").replace("http://cdn.example/logo.png", "logo2.png");
g.innerHTML = '<iframe id="m" src="' + URL.createObjectURL(new Blob([withBase], { type: "text/html" })) + '"></iframe>';
// A stylesheet built so (monotote's theme): its URLs resolve against the
// document's base, relative ones too.
const css = '@import url("http://cdn.example/theme.css"); body { background: url(http://cdn.example/bg.png), url(rel.png); }';
const l = document.createElement("link");
l.rel = "stylesheet";
const cssUrl = URL.createObjectURL(new Blob([css], { type: "text/css" }));
l.href = cssUrl;
document.head.appendChild(l);
window.sameCss = l.href === cssUrl;
// A document without a base: a reference without a scheme fails on both
// sides; a base that cannot resolve is passed over, the next one counts.
const nb = document.createElement("iframe");
nb.src = URL.createObjectURL(new Blob(['<!doctype html><img src="rel2.png"><img src="/rel2.png"><img src="//cdn.example/sr.png"><img src="http://cdn.example/abs.png">' +
  '<base href="rel/"><img src="rel2.png"><base href="http://cdn.example/b3/"><img src="after.png">'], { type: "text/html" }));
document.body.appendChild(nb);
// Not HTML: loads as given.
const t = document.createElement("iframe");
t.src = URL.createObjectURL(new Blob(["just text http://cdn.example/text.png"], { type: "text/plain" }));
document.body.appendChild(t);
`;

describe.skipIf(!wanted)("a frame's blob: HTML document, in Chromium", () => {
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
            if (/lib2?\.js$/.test(u)) {
                res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" });
                return res.end("window.libLoaded = 1;");
            }
            if (u === "/direct" || u.startsWith("/cyrano/https/site.example/page")) {
                const boot = u === "/direct" ? "" : `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/page");</script>`;
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(`<!doctype html><html><head>${boot}</head><body><script>${SCRIPT}</script></body></html>`);
            }
            res.writeHead(204);
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

    const run = async (path: string): Promise<{ ran: unknown; markupRan: unknown; sameUrl: unknown; fetched: string[] }> => {
        const page = await browser.newPage();
        const fetched: string[] = [];
        page.on("request", (r) => { const u = r.url(); if (/cdn\.example|rel2?\.png/.test(u)) fetched.push(u); });
        await page.goto(origin + path);
        await page.waitForTimeout(500);
        await page.waitForFunction("window.frameRan !== undefined && window.markupRan !== undefined", undefined, { timeout: 5000 }).catch(() => {});
        const got = await page.evaluate(() => ({ ran: (window as unknown as { frameRan?: unknown }).frameRan, markupRan: (window as unknown as { markupRan?: unknown }).markupRan, sameUrl: (window as unknown as { sameUrl?: unknown }).sameUrl && (window as unknown as { sameCss?: unknown }).sameCss }));
        await page.close();
        return { ...got, fetched };
    };

    it("loads the document's resources through the proxy, runs it, reads back the page's URL", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/page");
        const names = (xs: string[]): string[] => xs.map((u) => u.replace(/^.*cdn\.example/, "").replace(/^.*\/(rel2?\.png)$/, "/$1")).sort();
        expect(direct).toMatchObject({ ran: "number", markupRan: "number", sameUrl: true });
        expect(names(direct.fetched)).toEqual(["/abs.png", "/b/lib2.js", "/b/logo2.png", "/b3/after.png", "/bg.png", "/lib.js", "/logo.png", "/rel.png", "/theme.css"]);
        expect({ ran: proxied.ran, markupRan: proxied.markupRan, sameUrl: proxied.sameUrl }).toEqual({ ran: direct.ran, markupRan: direct.markupRan, sameUrl: direct.sameUrl });
        expect(names(proxied.fetched)).toEqual(names(direct.fetched));
        expect(proxied.fetched.filter((u) => !u.startsWith(origin))).toEqual([]);
    });
});
