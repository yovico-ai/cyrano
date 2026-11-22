// @vitest-environment node
//
// import() in code a script makes at run time (new Function, eval), in
// real Chromium, direct and proxied. Natively the specifier resolves
// against the script that made the code: Usercentrics makes
// `new Function("u", "return import(u)")` in its module and imports
// "./DefaultData-….js" through it (halespropertymanagement.com,
// 2026-11-22). Rewritten, it resolved against the page and got a 404.
//
// (A classic script fetched cross-origin without CORS resolves nothing:
// its base is about:blank — Chromium's message. Through the proxy every
// script is same-origin and CORS-fetched, so there it resolves: a known
// gap, not tested here. This one is fetched with crossorigin.)
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

type Req = { url(): string };
type Page = { goto(u: string): Promise<unknown>; waitForFunction(f: string, a?: unknown, o?: object): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

// The module and the classic script that make the code.
const MOD = `
const viaFunction = new Function("u", "return import(u)");
const r = {};
const tell = (k, p) => p.then((m) => { r[k] = m.name; }, (e) => { r[k] = "failed"; }).then(() => { if (Object.keys(r).length === 3) window.madeImports = r; });
tell("fn", viaFunction("./dep-fn.js"));
tell("eval", (0, eval)("import('./dep-eval.js')"));
tell("direct", eval("import('./dep-direct.js')"));
`;
const CLASSIC = `
window.classicImport = new Function("return import('./dep-classic.js')")().then((m) => m.name, (e) => "failed: " + e);
`;

const PAGE = `<script>
const m = document.createElement("script"); m.type = "module"; m.src = "http://cdn.example/lib/mod.js"; document.head.appendChild(m);
const c = document.createElement("script"); c.crossOrigin = "anonymous"; c.src = "http://cdn.example/old/classic.js"; document.head.appendChild(c);
</script>`;

describe.skipIf(!wanted)("import() in code a script makes, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            const js = { "content-type": "text/javascript", "access-control-allow-origin": "*" };
            if (u.startsWith("/rewriter.js")) {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            if (u === "/direct" || u.startsWith("/cyrano/https/site.example/page")) {
                const boot = u === "/direct" ? "" : `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/page");</script>`;
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(`<!doctype html><html><head>${boot}</head><body>${PAGE}</body></html>`);
            }
            // Proxied, a script is served as the server rewrites it (its own URL the base of import()).
            const served = (src: string, url: string): string => u.startsWith("/cyrano/") ? rewriteJsSource(src, { ...defaultJsRewriteOptions(), baseUrl: url }) : src;
            if (/\/lib\/mod\.js$/.test(u)) { res.writeHead(200, js); return res.end(served(MOD, "http://cdn.example/lib/mod.js")); }
            if (/\/old\/classic\.js$/.test(u)) { res.writeHead(200, js); return res.end(served(CLASSIC, "http://cdn.example/old/classic.js")); }
            const dep = /\/(lib|old)\/(dep-[a-z]+)\.js$/.exec(u);
            if (dep) { res.writeHead(200, js); return res.end(`export const name = "${dep[1]}/${dep[2]}";`); }
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

    const run = async (path: string): Promise<{ got: unknown; fetched: string[] }> => {
        const page = await browser.newPage();
        const fetched: string[] = [];
        page.on("request", (r) => { const u = r.url(); if (/dep-/.test(u)) fetched.push(u); });
        await page.goto(origin + path);
        await page.waitForFunction("window.madeImports !== undefined", undefined, { timeout: 5000 }).catch(() => {});
        const got = await page.evaluate(async () => {
            const w = window as unknown as { madeImports?: unknown; classicImport?: Promise<unknown> };
            return { module: w.madeImports, classic: await w.classicImport };
        });
        await page.close();
        return { got, fetched };
    };

    it("resolves against the script that made the code, through the proxy", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/page");
        expect(direct.got).toEqual({ module: { fn: "lib/dep-fn", eval: "lib/dep-eval", direct: "lib/dep-direct" }, classic: "old/dep-classic" });
        expect(proxied.got).toEqual(direct.got);
        expect(proxied.fetched.filter((u) => !u.startsWith(origin))).toEqual([]);
    });
});
