// @vitest-environment node
//
// An SVG document embedded by a page, in real Chromium, direct and through
// the real proxy (pokemon-vortex.com, 2026-11-22: an SVG logo embedded
// with <object> loaded its @font-face from the origin). The server
// rewrites such a document as XML and gives it the XML bootstrap
// (spec/XmlDoc.agda, Disposition.agda asXml; Go htmlrewrite.RewriteXML):
// its style, its xlink:href, what its own script fetches and adds must go
// through the proxy — the same requests as direct, none outside — and its
// script reads its own URL and its attributes as written (the originals,
// taken before a parser-inserted script runs: the XML parser has no
// microtask checkpoint there). The <object> both as the parser makes it and
// as a script makes it; and an XHTML document (application/xhtml+xml, also
// rewritten as XML: the HTML rewriter's output need not be well-formed).
//
// Runs the server binary (go/assets/cyrano: ./go/scripts/build.sh) on a
// free port. Needs it and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const binary = process.env.CYRANO_BINARY ?? resolve(root, "go/assets/cyrano");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(binary);

type Req = { url(): string };
type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const svg = (self: string): string => `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="60" height="60">
<style>@font-face { font-family: im; src: url('${self}/impact.ttf') } text { font-family: im }</style>
<image xlink:href="${self}/img.gif" width="5" height="5"/><text x="1" y="20">Hi</text>
<script><![CDATA[ fetch("${self}/fetched.gif"); var i = document.createElementNS("http://www.w3.org/2000/svg", "image");
i.setAttribute("href", "${self}/added.gif"); i.setAttribute("width", "5"); i.setAttribute("height", "5");
document.documentElement.appendChild(i);
var im = document.getElementsByTagName("image")[0];
parent.postMessage("svg:" + location.href + "|" + im.getAttribute("xlink:href") + "|" + im.getAttributeNS("http://www.w3.org/1999/xlink", "href") + "|" + i.getAttribute("href") + "|" + im.hasAttribute("crn-o"), "*"); ]]></script>
</svg>`;

const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

describe.skipIf(!wanted)("an SVG document embedded by a page, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = req.url ?? "/";
            const page = (object: string): string => `<!doctype html><body>${object}<p>x</p><script>addEventListener("message", (e) => { window.out = e.data; });</script></body>`;
            if (u === "/parsed.html") {
                res.writeHead(200, { "content-type": "text/html" });
                return res.end(page(`<object type="image/svg+xml" data="${self}/logo.svg" width="60" height="60"></object>`));
            }
            if (u === "/scripted.html") {
                res.writeHead(200, { "content-type": "text/html" });
                return res.end(page(`<script>const o = document.createElement("object"); o.type = "image/svg+xml"; o.data = "${self}/logo.svg"; o.width = 60; o.height = 60; document.body.appendChild(o);</script>`));
            }
            if (u === "/page.xhtml") {
                // An XHTML document, navigated to: its image, its script's fetch, its own URL.
                res.writeHead(200, { "content-type": "application/xhtml+xml" });
                return res.end(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>` +
                    `<img src="${self}/xhtml.gif" alt=""/><script>//<![CDATA[\nfetch("${self}/xfetch.gif"); window.out = "xhtml:" + location.href + ":" + (1 < 2);\n//]]></script></body></html>`);
            }
            if (u === "/logo.svg") {
                res.writeHead(200, { "content-type": "image/svg+xml" });
                return res.end(svg(self));
            }
            if (u.endsWith(".ttf")) {
                res.writeHead(200, { "content-type": "font/ttf", "access-control-allow-origin": "*" });
                return res.end("x");
            }
            if (u.endsWith(".gif")) {
                res.writeHead(200, { "content-type": "image/gif", "access-control-allow-origin": "*" });
                return res.end(GIF);
            }
            res.writeHead(404);
            return res.end();
        });
        await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
        self = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
        const port = await free();
        proxyOrigin = `http://localhost:${port}`;
        proxy = spawn(binary, ["--assets", resolve(root, "go/assets"), "--log-level", "warn"], {
            env: { ...process.env, CYRANO_PUBLIC_URL: proxyOrigin, CYRANO_PORT: String(port), CYRANO_HOSTNAME: "localhost", CYRANO_HTTPS_ENABLED: "false" },
            stdio: "ignore",
        });
        for (let i = 0; i < 100; i++) {
            try { if ((await fetch(proxyOrigin + "/")).ok) break; } catch { /* starting */ }
            await new Promise((r) => setTimeout(r, 100));
        }
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        await browser?.close();
        proxy?.kill();
        upstream?.close();
    });

    const run = async (url: string): Promise<{ out: unknown; assets: string[]; outside: string[] }> => {
        const page = await browser.newPage();
        const all: string[] = [];
        page.on("request", (r) => all.push(r.url()));
        await page.goto(url);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 2000)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return {
            out,
            assets: all.filter((u) => /\.(svg|ttf|gif)/.test(u)).map((u) => u.replace(/^.*\//, "")).sort(),
            outside: all.filter((u) => !u.startsWith(proxyOrigin) && !/^(data|blob):/.test(u)),
        };
    };

    it("an XHTML document: through the proxy, as direct", async () => {
        const direct = await run(`${self}/page.xhtml`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/${self.slice(7)}/page.xhtml`);
        expect(direct.out).toBe(`xhtml:${self}/page.xhtml:true`);
        expect(direct.assets).toEqual(["xfetch.gif", "xhtml.gif"]);
        expect(proxied.out).toBe(direct.out);
        expect(proxied.assets).toEqual(direct.assets);
        expect(proxied.outside).toEqual([]);
    });

    for (const how of ["parsed", "scripted"]) {
        it(`an <object> ${how}: everything through the proxy, as direct`, async () => {
            const direct = await run(`${self}/${how}.html`);
            const proxied = await run(`${proxyOrigin}/cyrano/http/${self.slice(7)}/${how}.html`);
            expect(direct.out).toBe(`svg:${self}/logo.svg|${self}/img.gif|${self}/img.gif|${self}/added.gif|false`);
            expect(direct.assets).toEqual(["added.gif", "fetched.gif", "img.gif", "impact.ttf", "logo.svg"]);
            expect(proxied.out).toBe(direct.out);
            expect(proxied.assets).toEqual(direct.assets);
            expect(proxied.outside).toEqual([]);
        });
    }
});
