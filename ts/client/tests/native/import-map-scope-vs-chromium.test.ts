// @vitest-environment node
//
// An import map scope that covers the document, in real Chromium, direct
// and through the real proxy (spec/ImportMap.agda rewriteImportMapT). A
// scope prefix is proxified as a module URL (marked !js); an inline
// module's referrer is the document's URL, of another mark, so
// `"scopes": {"/": …}` never applied to it (round I). Both a static map
// and one a script inserts.
//
// Needs the server binary and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const binary = process.env.CYRANO_BINARY ?? resolve(root, "go/assets/cyrano");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(binary);

type Req = { url(): string };
type Page = { goto(u: string): Promise<unknown>; reload(): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };



const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

const PAGE = (dynamic: boolean): string => `<!doctype html>` + (dynamic
    ? `<script>const m = document.createElement("script"); m.type = "importmap"; m.textContent = JSON.stringify({ scopes: { "/": { "rootscoped": "/m/dep.mjs" }, "/m/": { "scoped-dep": "/m/dep2.mjs" } } }); document.head.append(m);</script>`
    : `<script type=importmap>{"scopes":{"/":{"rootscoped":"/m/dep.mjs"},"/m/":{"scoped-dep":"/m/dep2.mjs"}}}</script>`)
    + `<script type=module>window.out = (async () => { const o = {};
  try { o.root = (await import("rootscoped")).v; } catch (e) { o.root = e.name; }
  try { o.inner = (await import("/m/user.mjs")).v; } catch (e) { o.inner = e.name; }
  return o; })();</script>`;

describe.skipIf(!wanted)("import map scopes, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            const js = (b: string): void => { res.writeHead(200, { "content-type": "text/javascript" }); res.end(b); };
            if (u.pathname === "/m/dep.mjs") return js("export const v = 'dep';");
            if (u.pathname === "/m/dep2.mjs") return js("export const v = 'dep2';");
            if (u.pathname === "/m/user.mjs") return js("export { v } from 'scoped-dep';");
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(PAGE(u.searchParams.has("dyn")));
        });
        await new Promise<void>((r) => upstream.listen(0, "0.0.0.0", () => r()));
        port0 = (upstream.address() as { port: number }).port;
        const port = await free();
        proxyOrigin = `http://localhost:${port}`;
        proxy = spawn(binary, ["--assets", process.env.CYRANO_ASSETS ?? resolve(root, "go/assets"), "--log-level", "warn"], {
            env: { ...process.env, CYRANO_PUBLIC_URL: proxyOrigin, CYRANO_PORT: String(port), CYRANO_HOSTNAME: "localhost", CYRANO_HTTPS_ENABLED: "false" },
            stdio: "ignore",
        });
        for (let i = 0; i < 100; i++) {
            try { if ((await fetch(proxyOrigin + "/")).ok) break; } catch { /* starting */ }
            await new Promise((r) => setTimeout(r, 100));
        }
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        await browser?.close();
        proxy?.kill();
        upstream?.close();
    });

    const run = async (url: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(url);
        const out = await page.evaluate(() => (window as unknown as { out: Promise<unknown> }).out);
        await page.close();
        return out;
    };

    it("applies the document's scope as directly", async () => {
        for (const q of ["", "?dyn"]) {
            const direct = await run(`http://127.0.0.1:${port0}/page${q}`);
            const proxied = await run(`${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page${q}`);
            expect(direct, q).toEqual({ root: "dep", inner: "dep2" });
            expect(proxied, q).toEqual(direct);
        }
    }, 120_000);
});
