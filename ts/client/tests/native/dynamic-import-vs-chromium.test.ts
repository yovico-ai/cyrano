// @vitest-environment node
//
// import() with a specifier that is not a string, in real Chromium, direct
// and proxied. import() takes the string of what it is given; the runtime's
// wrap_import_arg proxified strings only, so a URL object —
// `import(new URL("/assets/x.js", import.meta.url))`, as Vite and Yext's
// pages write it (restaurants.subway.com, 2026-11-21) — was fetched from
// the origin, outside the proxy, and failed CORS. An object with its own
// toString, one whose toString throws (the import rejects, it does not
// throw), and a symbol (a TypeError, as a rejection) must all behave as
// direct, and no request may leave the proxy.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rewriteUrl } from "../../src/url/containment";
import { defaultJsRewriteOptions, rewriteJsSource } from "../../src/js/rewriter";
import type { ClientConfig } from "../../src/config";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Req = { url(): string };
type Page = { goto(u: string): Promise<unknown>; waitForFunction(f: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const MODULE = `
const out = [];
out.push((await import(new URL("/m/a.js", import.meta.url))).v);
out.push((await import({ toString() { return "/m/b.js"; } })).v);
let sync = "no";
try { import({ toString() { throw new RangeError("nope"); } }).catch(() => {}); } catch (e) { sync = "throws"; }
out.push("sync " + sync);
try { await import({ toString() { throw new RangeError("nope"); } }); out.push("resolved"); } catch (e) { out.push("rejects " + e.constructor.name + " " + e.message); }
try { await import(Symbol("s")); out.push("resolved"); } catch (e) { out.push("rejects " + e.constructor.name); }
out.push((await import(new URL("./c.js", import.meta.url))).v);
window.got = out;`;

describe.skipIf(!wanted)("import() of a non-string specifier in Chromium, direct and proxied", () => {
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
                if (!proxied) return res.end(`<!doctype html><script type="module" src="/m/mod.js"></script>`);
                return res.end(`<!doctype html><script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(proxy)},source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(page.href)});</script>` +
                    `<script type="module" src="${rewriteUrl("/m/mod.js", page, cfg, undefined, "js")}"></script>`);
            }
            if (path === "/m/mod.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                if (!proxied) return res.end(MODULE);
                const base = `${origin}/m/mod.js`;
                return res.end(rewriteJsSource(MODULE, { ...defaultJsRewriteOptions(), baseUrl: base, proxify: (s, b) => rewriteUrl(s, new URL(b), cfg, undefined, "js") }));
            }
            const leaf = /^\/m\/([abc])\.js$/.exec(path);
            if (leaf) {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "access-control-allow-origin": "*" });
                return res.end(`export const v = "${leaf[1]}";`);
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

    const run = async (url: string): Promise<{ got: unknown; urls: string[] }> => {
        const page = await browser.newPage();
        const urls: string[] = [];
        page.on("request", (r) => urls.push(r.url()));
        await page.goto(url);
        await page.waitForFunction("window.got !== undefined");
        const got = await page.evaluate(() => (window as unknown as { got: unknown }).got);
        await page.close();
        return { got, urls };
    };

    it("loads the same modules as direct, all through the proxy", async () => {
        const direct = await run(`http://localhost:${port}/dir/page`);
        const proxied = await run(`http://127.0.0.1:${port}/cyrano/http/localhost:${port}/dir/page`);
        expect(direct.got).toEqual(["a", "b", "sync no", "rejects RangeError nope", "rejects TypeError", "c"]);
        expect(proxied.got).toEqual(direct.got);
        expect(proxied.urls.filter((u) => !u.startsWith(`http://127.0.0.1:${port}/`))).toEqual([]);
    }, 30_000);
});
