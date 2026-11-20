// @vitest-environment node
//
// Members that are written, in real Chromium, direct and proxied (the
// page's script rewritten as the server does). V8 names an anonymous
// function from the target it is assigned to — `obj.<computed>`,
// `a.b.<computed>`, `obj.parent` — and shows the name in stack traces;
// with the target rewritten the frames read
// `$rewriter.wrap_member_expression` (Adobe Launch on tractorsupply.com,
// 2026-11-20). A write stays as written (rules R3, R5), so the names, and
// what the writes do, are as direct.
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

const JS = `
var frame = function (f) { try { f(); } catch (e) { return String(e.stack).split("\\n")[1].trim().replace(/ ?\\(.*$/, "").replace(/ https?:.*$/, ""); } return "no throw"; };
var boom = function () { throw new Error("x"); };
var out = {}, k = "run", obj = {}, a = { b: {} }, holder = { set: function () { this[k] = function () { boom(); }; } };
obj[k] = function () { boom(); };
a.b[k] = function () { boom(); };
holder.set();
obj.parent = function () { boom(); };
obj.top = function () { boom(); };
obj["K" + 1] = class { constructor() { boom(); } };
out.names = [frame(function () { obj[k](); }), frame(function () { a.b[k](); }), frame(function () { holder[k](); }),
  frame(function () { obj.parent(); }), frame(function () { obj.top(); }), frame(function () { new obj.K1(); })].map(function (s) { return s.split("\\n")[0]; });
// The frame that called boom, by name.
out.callers = [obj[k], a.b[k], holder[k], obj.parent, obj.top].map(function (f) { try { f(); } catch (e) { return String(e.stack).split("\\n")[2].trim().replace(/ ?\\(.*$/, ""); } });
// What the writes do: a window's own members by a computed key, and parent (replaceable).
var w = "crnProbe"; window[w] = 5; out.own = window.crnProbe;
var p = "parent"; window[p] = 7; out.parent = window.parent === 7;
var n = "name"; window[n] = "nm"; out.name = window.name;
window.got = out;
`;

describe.skipIf(!wanted)("written members in Chromium, direct and proxied", () => {
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
            if (!u.startsWith("/cyrano/")) return res.end(`<!doctype html><script>${JS}</script>`);
            const page = `http://localhost:${port}/p/page`;
            return res.end(`<!doctype html><script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(proxy)},source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(page)});</script><script>${rewriteJsSource(JS, defaultJsRewriteOptions())}</script>`);
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
        await page.goto(url);
        await page.waitForFunction("window.got !== undefined");
        const got = await page.evaluate(() => (window as unknown as { got: unknown }).got);
        await page.close();
        return got;
    };

    it("functions are named from their targets, and the writes land, as direct", async () => {
        const direct = await run(`http://localhost:${port}/p/page`) as { callers: string[] };
        expect(direct.callers).toEqual(["at obj.<computed>", "at a.b.<computed>", "at <computed>", "at obj.parent", "at obj.top"]);
        expect(direct).toMatchObject({ own: 5, parent: true, name: "nm" });
        expect(await run(`http://127.0.0.1:${port}/cyrano/http/localhost:${port}/p/page`)).toEqual(direct);
    }, 30_000);
});
