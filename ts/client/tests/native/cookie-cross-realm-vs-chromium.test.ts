// @vitest-environment node
//
// document.cookie through another window's accessor, in real Chromium,
// direct and proxied (round H: Quantum Metric on usbank, southwest, uline…
// takes its natives from a hidden frame; its session cookies went to the
// browser's own jar on the proxy origin and never showed, and its reads
// listed the channel). Each window's accessor serves the document it is
// called on through that document's own window: as directly.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const SCRIPT = `
const out = {};
document.cookie = "top=1; path=/";
const f = document.createElement("iframe"); document.body.append(f);
const theirs = Object.getOwnPropertyDescriptor(f.contentWindow.Document.prototype, "cookie");
theirs.set.call(document, "ifr=1; path=/");
out.pageSees = document.cookie.split("; ").sort().join("; ");
out.theirGetOnPage = theirs.get.call(document).split("; ").sort().join("; ");
f.contentDocument.cookie = "fromFrame=1; path=/";
const mine = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
out.myGetOnFrame = mine.get.call(f.contentDocument).split("; ").sort().join("; ");
out.frameSees = f.contentDocument.cookie.split("; ").sort().join("; ");
window.out = out;
`;

describe.skipIf(!wanted)("document.cookie through another window's accessor, in Chromium", () => {
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

    const run = async (path: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 300)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return out;
    };

    it("serves each document as its own window does, as direct", async () => {
        const direct = await run("/a/direct");
        const proxied = await run("/cyrano/https/site.example/a/page");
        expect(direct).toEqual({ pageSees: "ifr=1; top=1", theirGetOnPage: "ifr=1; top=1", myGetOnFrame: "fromFrame=1; ifr=1; top=1", frameSees: "fromFrame=1; ifr=1; top=1" });
        expect(proxied).toEqual(direct);
    });
});
