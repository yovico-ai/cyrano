// @vitest-environment node
//
// A fetch preload and the page's fetch() of it, in real Chromium, direct
// and proxied: the browser reuses the preload — one request — only when
// their credentials modes match. The runtime forced crossorigin to
// use-credentials on every link, so Spotify's `<link rel=preload as=fetch
// crossorigin=anonymous>` no longer matched its fetch() (credentials
// "same-origin") and the JSON was fetched twice — a script counting its
// resource entries could tell (2026-11-20; spec/Attrs.agda
// crossoriginValue: a fetch preload keeps its crossorigin).
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; waitForFunction(f: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const PROBE = `<script>
// As markup: the runtime's HTML rewriter, the server's counterpart.
document.head.insertAdjacentHTML("beforeend", '<link id="l" rel="preload" as="fetch" crossorigin="anonymous" href="http://cdn.test:PORT/data.json?k=KEY">');
var l = document.getElementById("l");
setTimeout(function () {
  fetch("http://cdn.test:PORT/data.json?k=KEY").then(function (r) { return r.text(); }).then(function () {
    setTimeout(function () {
      window.got = { entries: performance.getEntriesByType("resource").filter(function (e) { return e.name.indexOf("data.json") >= 0; }).length, cross: l.crossOrigin };
    }, 300);
  });
}, 500);
</script>`;

describe.skipIf(!wanted)("a fetch preload in Chromium, direct and proxied", () => {
    let browser: Browser;
    let server: Server;
    let port = 0;
    const hits = new Map<string, number>();

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const proxy = `http://127.0.0.1:${port}`;
            const u = req.url ?? "";
            if (u === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            const m = /data\.json\?k=(\w+)/.exec(u);
            if (m) {
                hits.set(m[1]!, (hits.get(m[1]!) ?? 0) + 1);
                res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
                return res.end("{}");
            }
            const key = /key=(\w+)/.exec(u)?.[1] ?? "x";
            const probe = PROBE.replace(/PORT/g, String(port)).replace(/KEY/g, key);
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            if (!u.startsWith("/cyrano/")) return res.end(`<!doctype html><head></head>${probe}`);
            const page = `http://localhost:${port}/p/page`;
            return res.end(`<!doctype html><head><script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(proxy)},source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(page)});</script></head>${probe}`);
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch({ args: ["--host-resolver-rules=MAP *.test 127.0.0.1, MAP localhost 127.0.0.1"] });
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const run = async (url: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(url);
        await page.waitForFunction("window.got !== undefined");
        const got = await page.evaluate(() => (window as unknown as { got: unknown }).got);
        await page.close();
        return got;
    };

    it("one request, as direct", async () => {
        const direct = await run(`http://localhost:${port}/p/page?key=d`);
        const proxied = await run(`http://127.0.0.1:${port}/cyrano/http/localhost:${port}/p/page?key=p`);
        expect(direct).toEqual({ entries: 1, cross: "anonymous" });
        expect(hits.get("d")).toBe(1);
        expect(proxied).toEqual(direct);
        expect(hits.get("p")).toBe(1);
    }, 30_000);
});
