// @vitest-environment node
//
// postMessage under Trusted Types, in real Chromium, direct and proxied.
// The runtime sends a page's message through a trampoline it compiles in
// the sender's realm (messaging/target-origin.ts callInRealmOf); with
// `require-trusted-types-for 'script'` a string body was a violation,
// fired at the page — "This document requires 'TrustedScript'
// assignment" (Pinterest, 2026-11-20). The message must arrive and no
// violation be seen, as direct.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rewriteCspContent } from "../../src/patches/html-rewriter";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { on(e: string, f: (x: { message?: string; text?: () => string }) => void): void; goto(u: string): Promise<unknown>; waitForFunction(f: () => unknown, a?: unknown, o?: { timeout: number }): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const CSP = "require-trusted-types-for 'script'; trusted-types *";
// The page posts to a frame (its own realm sends), and a frame's own
// script — written with the page's policy — posts to the page (the
// frame's realm sends, through the runtime of its creator).
const PROBE = `<iframe id="f" src="about:blank"></iframe><iframe id="g" src="about:blank"></iframe><script>
var v = [], res = {};
document.addEventListener("securitypolicyviolation", function (e) { v.push(e.violatedDirective + " " + e.sample); });
var f = document.getElementById("f").contentWindow, g = document.getElementById("g").contentWindow;
var done = function () { if (res.toFrame && res.fromFrame) setTimeout(function () { res.violations = v; window.got = res; }, 200); };
f.addEventListener("message", function (e) { res.toFrame = e.data; done(); });
window.addEventListener("message", function (e) { if (e.data === "from-frame") { res.fromFrame = [e.data, e.source === g]; done(); } });
f.postMessage("hi", "*");
var p = trustedTypes.createPolicy("page", { createHTML: function (s) { return s; } });
g.document.open(); g.document.write(p.createHTML("<script>parent.postMessage('from-frame', '*')<\\/script>")); g.document.close();
</script>`;

describe.skipIf(!wanted)("postMessage under Trusted Types in Chromium, direct and proxied", () => {
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const proxy = `http://127.0.0.1:${port}`;
            if (req.url === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            const proxied = (req.url ?? "").startsWith("/cyrano/");
            res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": proxied ? rewriteCspContent(CSP, proxy, "crn_tt_test") : CSP });
            if (!proxied) return res.end(`<!doctype html>${PROBE}`);
            const page = `http://localhost:${port}/p/page`;
            return res.end(`<!doctype html><script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(proxy)},source:"/rewriter.js",tt:"crn_tt_test"}).inject();$rewriter.set_location(${JSON.stringify(page)});</script>${PROBE}`);
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

    const run = async (url: string): Promise<unknown> => {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e.message)));
        await page.goto(url);
        // (A function, not a string: Trusted Types refuses a string to eval.)
        await page.waitForFunction(() => (window as unknown as { got?: unknown }).got !== undefined, undefined, { timeout: 8000 })
            .catch(() => { throw new Error(`${url}: no result; page errors: ${errors.join(" | ")}`); });
        const got = await page.evaluate(() => (window as unknown as { got: unknown }).got);
        await page.close();
        return got;
    };

    it("delivered, no violation", async () => {
        const direct = await run(`http://localhost:${port}/p/page`);
        const proxied = await run(`http://127.0.0.1:${port}/cyrano/http/localhost:${port}/p/page`);
        expect(direct).toEqual({ toFrame: "hi", fromFrame: ["from-frame", true], violations: [] });
        expect(proxied).toEqual(direct);
    }, 30_000);
});
