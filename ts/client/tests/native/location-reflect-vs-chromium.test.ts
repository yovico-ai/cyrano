// @vitest-environment node
//
// `location` reached through reflection, in real Chromium, direct and
// proxied: the object a script gets for `location` must be the one
// Reflect.get, the window's and the document's own getter (by descriptor,
// by __lookupGetter__) give — natively one Location; through the proxy
// the getters gave the native while names gave the runtime's view
// (PerimeterX's sensor on Zillow, 2026-11-20). And reading the URL off
// either gives the page's.
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

const PROBE = `var L = location, r = {};
var t = function (k, f) { try { r[k] = f(); } catch (e) { r[k] = "throws " + e.name; } };
t("reflect", function () { return Reflect.get(window, "location") === L; });
t("winGetter", function () { return Object.getOwnPropertyDescriptor(window, "location").get.call(window) === L; });
t("winGetterSame", function () { return Object.getOwnPropertyDescriptor(window, "location").get === Object.getOwnPropertyDescriptor(window, "location").get; });
t("docGetter", function () { return Object.getOwnPropertyDescriptor(document, "location").get.call(document) === L; });
t("descs", function () { return Object.getOwnPropertyDescriptors(window).location.get.call(window) === L; });
t("lookup", function () { return window.__lookupGetter__("location").call(window) === L; });
t("lookupSetter", function () { return typeof window.__lookupSetter__("location"); });
t("href", function () { return Reflect.get(window, "location").href; });
t("getterSrc", function () { return Function.prototype.toString.call(Object.getOwnPropertyDescriptor(window, "location").get); });
t("getterName", function () { return Object.getOwnPropertyDescriptor(window, "location").get.name; });
t("wrongThis", function () { return Object.getOwnPropertyDescriptor(window, "location").get.call({}); });
window.got = r;`;

describe.skipIf(!wanted)("location through reflection in Chromium, direct and proxied", () => {
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
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            if (!(req.url ?? "").startsWith("/cyrano/")) return res.end(`<!doctype html><script>${PROBE}</script>`);
            const page = `http://localhost:${port}/p/page`;
            return res.end(`<!doctype html><script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(proxy)},source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(page)});</script>` +
                `<script>${rewriteJsSource(PROBE, defaultJsRewriteOptions())}</script>`);
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

    it("one Location, the page's URL", async () => {
        const direct = await run(`http://localhost:${port}/p/page`);
        const proxied = await run(`http://127.0.0.1:${port}/cyrano/http/localhost:${port}/p/page`);
        expect((direct as { reflect: unknown }).reflect).toBe(true);
        expect(proxied).toEqual(direct);
    }, 30_000);
});
