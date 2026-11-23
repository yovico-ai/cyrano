// @vitest-environment node
//
// A child frame navigated by code the rules never saw, in real Chromium,
// direct and proxied (visitbellevue.com, 2026-11-22: an ad tag wrote
// `<body onload="window.location.href='https://pixel-sync.sitescout.com/…'">`
// into an empty frame, and the sync chain loaded from its origins). Each
// frame below is navigated to a page of cdn.example by another route; every
// navigation must reach the origin through the proxy, the same ones as
// direct. Requests are recorded by the server: what reached the origin
// directly arrives for host cdn.example.
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
const to = (n) => "http://cdn.example/" + n + ".html";
const frame = () => { const f = document.createElement("iframe"); document.body.appendChild(f); return f; };
// A handler written into an empty frame.
let f = frame(); f.contentDocument.open(); f.contentDocument.write('<body onload="window.location.href=\\'' + to("written") + '\\'">x</body>'); f.contentDocument.close();
// The frame's own eval.
f = frame(); f.contentWindow.eval("window.location.href='" + to("evalled") + "'");
// An onload attribute on the iframe (once).
const d = document.createElement("div");
d.innerHTML = '<iframe onload="if(!this.dataset.done){this.dataset.done=1;this.contentWindow.location.href=\\'' + to("onload") + '\\'}"></iframe>';
document.body.appendChild(d);
// By reflection from the top document.
f = frame(); const k = ["loc", "ation"].join(""); f.contentWindow[k].href = to("reflected");
`;

describe.skipIf(!wanted)("child frames navigated off the rules, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";
    let seen: string[] = [];

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
                // The page's code as the server sends it: rewritten (here by the
                // runtime, the same rules; direct, as written).
                return res.end(`<!doctype html><html><head>${boot}</head><body><script>const s = document.createElement("script"); s.text = ${JSON.stringify(SCRIPT).replace(/</g, "\\u003c")}; document.body.appendChild(s);</script></body></html>`);
            }
            if (/\.html$/.test(u)) {
                seen.push(`${req.headers.host?.startsWith("cdn.example") ? "DIRECT" : "proxied"} ${u.replace(/^.*\/([a-z]+)\.html$/, "$1")}`);
                res.writeHead(200, { "content-type": "text/html" });
                return res.end("<!doctype html>ok");
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

    const run = async (path: string): Promise<string[]> => {
        seen = [];
        const page = await browser.newPage();
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 1500)));
        await page.close();
        return [...seen].sort();
    };

    it("every navigation goes through the proxy, as direct", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/page");
        expect(direct).toEqual(["DIRECT evalled", "DIRECT onload", "DIRECT reflected", "DIRECT written"]);
        expect(proxied).toEqual(["proxied evalled", "proxied onload", "proxied reflected", "proxied written"]);
    });
});
