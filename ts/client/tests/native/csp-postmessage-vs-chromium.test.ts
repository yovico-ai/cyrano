// @vitest-environment node
//
// postMessage from a frame whose CSP forbids eval, in real Chromium,
// direct and proxied. `parent.postMessage(…)` in the frame calls the
// parent's wrapper (the parent's copy of the runtime), which sends from the
// frame's realm through a trampoline (messaging/target-origin.ts
// callInRealmOf). It was compiled there by the frame's eval: under
// `script-src` without 'unsafe-eval' refused, and every message a
// securitypolicyviolation the frame's page saw (Disqus, Google sign-in,
// Facebook frames on dexterdaily.com, 2026-11-22). A frame with a runtime
// of its own sends through it: nothing is compiled. The message must
// arrive from the frame, and no violation be seen, as direct.
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

type Page = { on(e: string, f: (x: { message?: string }) => void): void; goto(u: string): Promise<unknown>; waitForFunction(f: string, a?: unknown, o?: { timeout: number }): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const FRAME_CSP = "script-src 'self' 'unsafe-inline'";
const PAGE = `<iframe id="f" src="frame"></iframe><script>
window.res = { got: [] };
window.addEventListener("message", function (e) {
  if (e.data && e.data.violations) { res.violations = e.data.violations; return; }
  res.got.push([e.data, e.source === document.getElementById("f").contentWindow]);
});
</script>`;
const FRAME = `<script>
var v = [];
document.addEventListener("securitypolicyviolation", function (e) { v.push(e.violatedDirective + " " + e.blockedURI); });
parent.postMessage("one", "*");
parent.postMessage("two", "*");
setTimeout(function () { parent.postMessage({ violations: v }, "*"); }, 300);
</script>`;

describe.skipIf(!wanted)("postMessage from a frame without 'unsafe-eval', in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const proxy = `http://127.0.0.1:${port}`;
            const u = req.url ?? "/";
            if (u === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            const proxied = u.startsWith("/cyrano/");
            const isFrame = /\/frame$/.test(u);
            const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
            if (isFrame) headers["content-security-policy"] = proxied ? rewriteCspContent(FRAME_CSP, proxy, "crn_tt_test") : FRAME_CSP;
            res.writeHead(200, headers);
            const body = isFrame ? FRAME : PAGE;
            if (!proxied) return res.end(`<!doctype html>${body}`);
            const where = `http://localhost:${port}/p/${isFrame ? "frame" : "page"}`;
            return res.end(`<!doctype html><script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(proxy)},source:"/rewriter.js",tt:"crn_tt_test"}).inject();$rewriter.set_location(${JSON.stringify(where)});</script>${body}`);
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
        await page.waitForFunction("window.res && window.res.violations !== undefined", undefined, { timeout: 8000 })
            .catch(() => { throw new Error(`${url}: no result; page errors: ${errors.join(" | ")}`); });
        const got = await page.evaluate(() => (window as unknown as { res: unknown }).res);
        await page.close();
        return got;
    };

    it("delivered from the frame, no violation", async () => {
        const direct = await run(`http://localhost:${port}/p/page`);
        const proxied = await run(`http://127.0.0.1:${port}/cyrano/http/localhost:${port}/p/page`);
        expect(direct).toEqual({ got: [["one", true], ["two", true]], violations: [] });
        expect(proxied).toEqual(direct);
    }, 30_000);
});
