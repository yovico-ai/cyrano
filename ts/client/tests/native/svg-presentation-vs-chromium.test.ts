// @vitest-environment node
//
// An SVG presentation attribute naming the page itself, in real Chromium,
// direct and proxied. Google Charts writes clip-path="url(<page URL>#id)"
// from location.href: directly a reference into the document; proxied —
// the page's URL being the proxy's — an external document, which Chromium
// fetched (outside the proxy: definitions.net, 2026-11-20) and never
// applied. The attribute's url()s are rewritten as CSS (spec/Attrs.agda
// cssValue): the clip applies, nothing is fetched, the page reads back
// what it wrote.
//
// The page's script is rewritten as the server would (location.href then
// reads the original URL, as on the page).
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultJsRewriteOptions, rewriteJsSource } from "../../src/js/rewriter";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; waitForFunction(f: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

// Three ways to set it; each rect is 100x100, clipped to its own top-left 10x10.
const PROBE = `<svg width="400" height="120" style="position:absolute;left:0;top:0">
<defs><clipPath id="c" clipPathUnits="objectBoundingBox"><rect width="0.1" height="0.1"/></clipPath></defs>
<rect id="r1" width="100" height="100" fill="red"/>
<g id="h"></g>
<rect id="r3" x="250" width="100" height="100" fill="blue"/>
</svg><script>
var u = location.href.replace(/#.*/, "") + "#c";
document.getElementById("r1").setAttribute("clip-path", "url(" + u + ")");
document.getElementById("h").innerHTML = '<rect id="r2" x="120" width="100" height="100" fill="green" clip-path="url(' + u + ')"/>';
document.getElementById("r3").style.clipPath = "url(" + u + ")";
requestAnimationFrame(function () { requestAnimationFrame(function () {
  var hit = function (x, y) { var e = document.elementFromPoint(x, y); return e ? e.id || e.tagName : null; };
  window.got = {
    inside: [hit(5, 5), hit(125, 5), hit(255, 5)],
    outside: [hit(50, 50), hit(170, 50), hit(300, 50)],
    attr: [document.getElementById("r1").getAttribute("clip-path") === "url(" + u + ")", document.getElementById("r2").getAttribute("clip-path") === "url(" + u + ")"],
  };
}); });
</script>`;

describe.skipIf(!wanted)("an SVG presentation attribute naming the page, in Chromium, direct and proxied", () => {
    let browser: Browser;
    let server: Server;
    let port = 0;
    const pageHits: string[] = [];

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const proxy = `http://127.0.0.1:${port}`;
            const u = req.url ?? "";
            if (u === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            pageHits.push(u);
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            if (!u.startsWith("/cyrano/")) return res.end(`<!doctype html><body style="margin:0">${PROBE}`);
            const page = `http://localhost:${port}/p/page`;
            return res.end(`<!doctype html><script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(proxy)},source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(page)});</script><body style="margin:0">${PROBE.replace(/<script>([\s\S]*)<\/script>/, (_m, js: string) => `<script>${rewriteJsSource(js, defaultJsRewriteOptions())}</script>`)}`);
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch({ args: ["--host-resolver-rules=MAP localhost 127.0.0.1"] });
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const run = async (url: string): Promise<{ got: unknown; hits: number }> => {
        pageHits.length = 0;
        const page = await browser.newPage();
        await page.goto(url);
        await page.waitForFunction("window.got !== undefined");
        const got = await page.evaluate(() => (window as unknown as { got: unknown }).got);
        await page.close();
        return { got, hits: pageHits.length };
    };

    it("the clip applies, nothing is fetched, the page reads what it wrote", async () => {
        const direct = await run(`http://localhost:${port}/p/page`);
        expect(direct.got).toEqual({ inside: ["r1", "r2", "r3"], outside: ["svg", "svg", "svg"], attr: [true, true] });
        expect(direct.hits).toBe(1); // the page itself, once
        const proxied = await run(`http://127.0.0.1:${port}/cyrano/http/localhost:${port}/p/page`);
        expect(proxied.got).toEqual(direct.got);
        expect(proxied.hits).toBe(1);
    }, 30_000);
});
