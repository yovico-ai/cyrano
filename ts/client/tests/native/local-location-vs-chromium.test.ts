// @vitest-environment node
//
// A binding of the page's named `location`, in real Chromium, direct and
// proxied. The rules wrap every bare `location` (no scope analysis); the
// runtime told nothing apart and handed back the window's location view, so
// Divi's late-CSS loader — `var location = handle.parentNode;
// location.insertBefore(link, …)` — threw "insertBefore is not a function"
// (helpmates.com, 2026-11-20). What the identifier holds decides: a
// Location is the view, anything else the page's own value.
//
// The page's script is rewritten as the server would.
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
var out = {};
(function () {
  var handle = document.getElementById("h");
  var location = handle.parentNode;
  var link = document.createElement("span"); link.id = "added";
  location.insertBefore(link, handle.nextSibling);
  out.inserted = document.getElementById("added").parentNode === handle.parentNode;
  location = 5; out.assigned = location;
})();
(function (location) { out.param = location.length; })("abcd");
(function () { var location; try { location.x; } catch (e) { out.undef = e.name; } })();
out.global = location.pathname;
out.hrefIsString = typeof location.href;
window.got = out;
`;

describe.skipIf(!wanted)("a binding named location, in Chromium, direct and proxied", () => {
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
            const body = `<div><p id="h">x</p></div>`;
            if (!u.startsWith("/cyrano/")) return res.end(`<!doctype html>${body}<script>${JS}</script>`);
            const page = `http://localhost:${port}/p/page`;
            return res.end(`<!doctype html><script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(proxy)},source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(page)});</script>${body}<script>${rewriteJsSource(JS, defaultJsRewriteOptions())}</script>`);
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

    it("the page's own value; the global still the original page's", async () => {
        const direct = await run(`http://localhost:${port}/p/page`);
        expect(direct).toEqual({ inserted: true, assigned: 5, param: 4, undef: "TypeError", global: "/p/page", hrefIsString: "string" });
        expect(await run(`http://127.0.0.1:${port}/cyrano/http/localhost:${port}/p/page`)).toEqual(direct);
    }, 30_000);
});
