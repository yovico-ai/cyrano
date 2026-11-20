// @vitest-environment node
//
// Stacks through code made with `new Function`, in real Chromium, direct
// and proxied. The runtime's Function stand-in makes such code, so V8 named
// the stand-in as its eval origin — "eval at make (…/rewriter.js:…)" —
// where natively it names the page's calling frame; Kasada's fingerprint
// reports it (Costco, 2026-11-20). Every stack must be as direct: the
// default text and what a page formatter reads off the call sites (eval
// origin, script name), for sloppy code and its closures, strict code,
// Function made at a script's top level, Function inside Function, and
// eval inside Function (spec/Stack.agda evalOrigin, untag).
//
// The script is rewritten by the TS rewriter. Needs the built bundle and
// Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ClientConfig } from "../../src/config";
import { defaultJsRewriteOptions, rewriteJsSource } from "../../src/js/rewriter";
import { rewriteUrl } from "../../src/url/containment";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; waitForFunction(f: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

// Each case on a line of its own, nothing rewritten before it on the line.
const APP = `var got = {};
for (var i = 0; i < 12; i++) new Function("return " + i); // later tags run past ...-10
var stackOf = function (f) { try { f(); } catch (e) { return e.stack; } };
var sitesOf = function (f) {
  var prev = Error.prepareStackTrace, out;
  Error.prepareStackTrace = function (e, s) { return s.slice(0, 4).map(function (x) { return [x.toString(), String(x.getEvalOrigin()), String(x.getScriptNameOrSourceURL()), String(x.getFileName()), x.isEval()]; }); };
  try { f(); } catch (e) { out = e.stack; }
  Error.prepareStackTrace = prev;
  return out;
};
var sloppy = new Function("a", "var inner = function inner() { return null.x; };\\nreturn inner();");
var strict = new Function("'use strict';\\nreturn undefined.y;");
var named = new Function("return null.z;\\n//# sourceURL=page-named.js");
function maker() { return new Function("return new Function('return null.n;')();"); }
var nested = maker();
// (Not on the body's first line: the runtime's preamble shifts its columns, a known gap.)
var withEval = new Function("\\nreturn eval('null.e');");
got.sloppy = stackOf(sloppy);
got.strict = stackOf(strict);
got.named = stackOf(named);
got.nested = stackOf(nested);
got.withEval = stackOf(withEval);
got.sites = sitesOf(sloppy);
got.nestedSites = sitesOf(nested);
window.got = got;
`;

describe.skipIf(!wanted)("stacks through new Function in Chromium, direct and proxied", () => {
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const origin = `http://localhost:${port}`;
            const proxy = `http://127.0.0.1:${port}`;
            const cfg: ClientConfig = { apiBaseURL: proxy, cacheKey: "", source: "/rewriter.js", version: "0", rewrite_css_selectors: false };
            if (req.url === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            const m = /^\/cyrano\/http(?:!js)?\/localhost:\d+(\/.*)$/.exec(req.url ?? "");
            const proxied = (req.headers.host ?? "").startsWith("127.0.0.1") && m !== null;
            const path = proxied ? m[1]! : req.url ?? "";
            const page = new URL(`${origin}/p/page`);
            if (path === "/p/page") {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                if (!proxied) return res.end(`<!doctype html><script src="/s/app.js"></script>`);
                return res.end(`<!doctype html><script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(proxy)},source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(page.href)});</script>` +
                    `<script src="${rewriteUrl("/s/app.js", page, cfg, undefined, "js")}"></script>`);
            }
            if (path === "/s/app.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(proxied ? rewriteJsSource(APP, defaultJsRewriteOptions()) : APP);
            }
            res.writeHead(404);
            return res.end();
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

    const run = async (url: string): Promise<Record<string, unknown>> => {
        const page = await browser.newPage();
        await page.goto(url);
        await page.waitForFunction("window.got !== undefined");
        const got = await page.evaluate(() => (window as unknown as { got: Record<string, unknown> }).got);
        await page.close();
        return got;
    };

    it("every stack reads as direct", async () => {
        const direct = await run(`http://localhost:${port}/p/page`);
        const proxied = await run(`http://127.0.0.1:${port}/cyrano/http/localhost:${port}/p/page`);
        expect(String(direct["sloppy"])).toContain(`eval at <anonymous> (http://localhost:${port}/s/app.js:`);
        for (const k of Object.keys(direct)) expect(proxied[k], k).toEqual(direct[k]);
    }, 30_000);
});
