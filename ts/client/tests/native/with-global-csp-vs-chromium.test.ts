// @vitest-environment node
//
// R13 (a strict function inside a `with` reaching the runtime) under a CSP
// without 'unsafe-eval', in real Chromium, direct and proxied
// (armorgames.com, okmagazine.com, 2026-11-23: the Facebook SDK in Disqus
// frames; kosho.or.jp, 2026-11-24: the SDK's own `var globalThis = this`
// over its sandbox object, `with (this)`). The global object is found
// without compiling code: no EvalError and no CSP violation, the value as
// direct.
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

// The frame's markup as the server sends it: the inline script rewritten
// (here by the runtime's srcdoc rewriting, the same rules).
const FRAME = `<meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline'"><script>
window.out = []; document.addEventListener("securitypolicyviolation", (e) => out.push("CSPV " + e.violatedDirective));
try { with ({ z: 1 }) { out.push("val " + (function () { "use strict"; var o = { a: 1 }, k = "a"; return o[k]; })()); } } catch (e) { out.push("THROW " + e.name); }
try { (function () { var globalThis = this; with (this) { out.push("sdk " + (function () { "use strict"; var r = { object: 2 }, e = {}; return r[typeof e]; })()); } }).call({ window, document }); } catch (e) { out.push("THROW " + e.name); }
<\/script>`;
const SCRIPT = `
const f = document.createElement("iframe"); f.srcdoc = ${JSON.stringify("__FRAME__")}; document.body.append(f);
setTimeout(() => { window.out = f.contentWindow.out; }, 1500);
`.replace('"__FRAME__"', JSON.stringify(FRAME).replace(/</g, "\\u003c"));

describe.skipIf(!wanted)("R13 under a CSP without 'unsafe-eval', in Chromium", () => {
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
        await page.evaluate(() => new Promise((res) => setTimeout(res, 2500)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return out;
    };

    it("runs as direct, with no eval", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/page");
        expect(direct).toEqual(["val 1", "sdk 2"]);
        expect(proxied).toEqual(direct);
    });
});
