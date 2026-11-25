// @vitest-environment node
//
// XPath over URL attributes, in real Chromium, direct and through the
// runtime (spec/XPath.agda widenXPath; round J: string(@href) gave the
// proxified URL and [@href="…"] on the page's URL matched nothing).
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
type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

// 1x1 transparent GIF.
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const SCRIPT = `
const out = {};
const d = document.createElement("div");
d.innerHTML = '<a id="xa" href="/p?x">l</a><img id="xi" src="https://cdn.example/i.gif"><a id="xb" href="#top">t</a>';
document.body.append(d);
const ev = (e, t) => { const r = document.evaluate(e, document, null, t, null); return t === 2 ? r.stringValue : t === 1 ? r.numberValue : t === 3 ? r.booleanValue : r.snapshotLength; };
out.str = ev('string(//a[@id="xa"]/@href)', 2);
out.count = ev('count(//a[@href="/p?x"])', 1);
out.countRev = ev("count(//*['https://cdn.example/i.gif' = @src])", 1);
out.ne = ev('count(//a[@href != "/p?x"])', 1);
out.frag = ev('count(//a[@href="#top"])', 1);
out.bool = ev('boolean(//img[@src="https://cdn.example/i.gif"])', 3);
out.attrNode = document.evaluate('//a[@id="xa"]/@href', document, null, 9, null).singleNodeValue.value;
const xe = new XPathEvaluator(); out.evaluator = xe.evaluate('count(//a[@href="/p?x"])', document, null, 1, null).numberValue;
out.expr = document.createExpression('count(//a[@href="/p?x"])').evaluate(document, 1).numberValue;
try { document.evaluate("//a[", document, null, 1, null); } catch (e) { out.bad = e.name + ": " + e.message; }
window.out = out;
`;


describe.skipIf(!wanted)("XPath over URL attributes, in Chromium, through the runtime", () => {
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
            if (u === "/direct" || u.startsWith("/cyrano/https/site.example/page")) {
                const boot = u === "/direct" ? "" : `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/page");</script>`;
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(`<!doctype html><html><head>${boot}</head><body><script>${SCRIPT}</script></body></html>`);
            }
            if (/\.gif$/.test(u)) {
                res.writeHead(200, { "content-type": "image/gif" });
                return res.end(GIF);
            }
            res.writeHead(404);
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

    const run = async (path: string): Promise<{ out: unknown; fetched: string[] }> => {
        const page = await browser.newPage();
        const fetched: string[] = [];
        page.on("request", (r) => { const u = r.url(); if (/\.gif$/.test(u)) fetched.push(u); });
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 500)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return { out, fetched: fetched.sort() };
    };

    it("matches and reads as directly", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/page");
        expect(direct.out).toMatchObject({ str: "/p?x", count: 1, countRev: 1, frag: 1, bool: true });
        expect(proxied.out).toEqual(direct.out);
    });
});
