// @vitest-environment node
//
// What the window-tree rules cost on a page that walks a large tree, in
// real Chromium, direct and proxied. Every `obj.parent` (and top,
// location, a computed one of those) asks whether obj is a window or a
// document (native/brand.ts); the answer came from a
// native accessor that throws for anything else, and a throw is costly:
// warframe.market spent 26 s of a 35 s load there (2026-11-20). An object's
// brand never changes, so the answer is remembered per object.
//
// The bound is loose (an order of magnitude above the remembered cost, far
// below the throwing one): the page cannot tell, but a user waits.
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

// A tree of 2,000 nodes, each read 100 times through its `parent` — R2
// wraps every `obj.parent` to ask whether obj is a window (a tree walk,
// as warframe.market's) — plus a window and a document, which must still
// read as themselves.
const JS = `
var root = { v: 0 }, nodes = [];
for (var i = 0; i < 2000; i++) nodes.push({ v: i, parent: root });
var t0 = performance.now(), sum = 0;
for (var r = 0; r < 100; r++) for (var j = 0; j < 2000; j++) sum += nodes[j].parent.v + nodes[j].v;
var ms = performance.now() - t0;
// 100,000 objects each read once: nothing remembered helps here.
var fresh = []; for (var k = 0; k < 100000; k++) fresh.push({ v: k, parent: root, top: 1, location: 2 });
var t1 = performance.now(), sum2 = 0;
for (var m = 0; m < fresh.length; m++) sum2 += fresh[m].parent.v + fresh[m].top + fresh[m].location;
var ms2 = performance.now() - t1;
// A Proxy sees exactly the traps it sees direct.
var traps = [];
var px = new Proxy({ parent: 7 }, new Proxy({}, { get: function (t, name) { traps.push(String(name)); return undefined; } }));
var viaProxy = px.parent;
var f = document.createElement("iframe"); document.documentElement.appendChild(f);
window.got = { sum: sum, sum2: sum2, ms: ms, ms2: ms2, title: document["title"], self: window.parent === window,
  traps: traps.join(","), viaProxy: viaProxy, frameParent: f.contentWindow.parent === window, docLocation: typeof document.location.href };
`;

describe.skipIf(!wanted)("a tree walk through obj.parent, in Chromium, direct and proxied", () => {
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const proxy = `http://127.0.0.1:${port}`;
            const u = req.url ?? "";
            if (u === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            if (!u.startsWith("/cyrano/")) return res.end(`<!doctype html><title>t</title><script>${JS}</script>`);
            const page = `http://localhost:${port}/p/page`;
            return res.end(`<!doctype html><title>t</title><script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(proxy)},source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(page)});</script><script>${rewriteJsSource(JS, defaultJsRewriteOptions())}</script>`);
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

    type Got = { sum: number; ms: number; ms2: number; title: string; self: boolean };
    const run = async (url: string): Promise<Got> => {
        const page = await browser.newPage();
        await page.goto(url);
        await page.waitForFunction("window.got !== undefined");
        const got = await page.evaluate(() => (window as unknown as { got: Got }).got);
        await page.close();
        return got;
    };

    it("as direct, at a cost the user does not wait for", async () => {
        const direct = await run(`http://localhost:${port}/p/page`);
        const proxied = await run(`http://127.0.0.1:${port}/cyrano/http/localhost:${port}/p/page`);
        expect({ ...proxied, ms: 0, ms2: 0 }).toEqual({ ...direct, ms: 0, ms2: 0 });
        expect(proxied.ms, `direct ${direct.ms.toFixed(1)} ms`).toBeLessThan(400);
        expect(proxied.ms2, `direct ${direct.ms2.toFixed(1)} ms`).toBeLessThan(1000);
    }, 30_000);
});
