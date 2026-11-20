// @vitest-environment node
//
// import.meta.resolve, in real Chromium, direct and proxied (R15). The
// native resolves against the module's own URL, which proxied is the
// proxy's: IKEA's Vite preload helper resolved "/global/assets/…" to the
// proxy's root and its module preloads went nowhere (2026-11-19). Every
// answer — relative, root-relative, absolute, a bare specifier the import
// map holds, one it remaps, one it does not know (an error) — and the
// function itself (identity, name, length, source) must be as direct.
//
// The module is rewritten by the TS rewriter (the Go one is held to the
// same rule by spec/js-rewrite/cases.json), the import map by the
// client's rewriteImportMap. Needs the built bundle and Playwright's
// Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ClientConfig } from "../../src/config";
import { defaultJsRewriteOptions, rewriteJsSource } from "../../src/js/rewriter";
import { rewriteImportMap } from "../../src/patches/dynamic-html";
import { rewriteUrl } from "../../src/url/containment";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; waitForFunction(f: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const MAP = '{"imports":{"lib":"/m/lib.js","/m/remap.js":"/m/other.js","pre/":"./pkg/"}}';
const MODULE = `
const specs = ["./a.js", "/b.js", "../c.js?q=1#f", "https://x.example/y.js", "lib", "pre/z.js", "/m/remap.js", "nope", "data:text/javascript,1"];
const r = import.meta.resolve;
window.got = {
    answers: specs.map((s) => { try { return import.meta.resolve(s); } catch (e) { return "throws " + e.constructor.name; } }),
    detached: r("./d.js"),
    same: import.meta.resolve === import.meta.resolve,
    shape: [typeof import.meta.resolve, import.meta.resolve.name, import.meta.resolve.length, Function.prototype.toString.call(import.meta.resolve)],
    none: (() => { try { return import.meta.resolve(); } catch (e) { return "throws " + e.constructor.name; } })(),
};`;

describe.skipIf(!wanted)("import.meta.resolve in Chromium, direct and proxied", () => {
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const host = req.headers.host ?? "";
            const origin = `http://localhost:${port}`;
            const proxy = `http://127.0.0.1:${port}`;
            const cfg: ClientConfig = { apiBaseURL: proxy, cacheKey: "", source: "/rewriter.js", version: "0", rewrite_css_selectors: false };
            if (req.url === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            const m = /^\/cyrano\/http(?:!js)?\/localhost:\d+(\/.*)$/.exec(req.url ?? "");
            const proxied = host.startsWith("127.0.0.1") && m !== null;
            const path = proxied ? m[1]! : req.url ?? "";
            const page = new URL(`${origin}/dir/page`);
            if (path === "/dir/page") {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                if (!proxied) return res.end(`<!doctype html><script type="importmap">${MAP}</script><script type="module" src="/m/mod.js"></script>`);
                const map = rewriteImportMap(MAP, (u) => rewriteUrl(u, page, cfg, undefined, "js"));
                return res.end(`<!doctype html><script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(proxy)},source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(page.href)});</script>` +
                    `<script type="importmap">${map}</script><script type="module" src="${rewriteUrl("/m/mod.js", page, cfg, undefined, "js")}"></script>`);
            }
            if (path === "/m/mod.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                if (!proxied) return res.end(MODULE);
                const base = `${origin}/m/mod.js`;
                return res.end(rewriteJsSource(MODULE, { ...defaultJsRewriteOptions(), baseUrl: base, proxify: (s, b) => rewriteUrl(s, new URL(b), cfg, undefined, "js") }));
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

    const run = async (url: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(url);
        await page.waitForFunction("window.got !== undefined");
        const got = await page.evaluate(() => (window as unknown as { got: unknown }).got);
        await page.close();
        return got;
    };

    it("answers as direct", async () => {
        const direct = await run(`http://localhost:${port}/dir/page`);
        const proxied = await run(`http://127.0.0.1:${port}/cyrano/http/localhost:${port}/dir/page`);
        expect((direct as { answers: string[] }).answers[1]).toBe(`http://localhost:${port}/b.js`);
        expect(proxied).toEqual(direct);
    }, 30_000);
});
