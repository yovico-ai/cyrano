// @vitest-environment node
//
// The Origin header of same-origin CORS requests, in real Chromium, direct
// and through the real proxy (jetblue.com, round H: its CDN answers 403 to
// its own module scripts, stylesheets and fonts without Origin, and the
// proxy sent none). Chromium sends it on a same-origin CORS request for a
// script, style, font or image, not on fetch() / XHR GETs (spec/Referrer.agda
// originHeader): what the origin receives for each, as directly.
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
type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };



const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

describe.skipIf(!wanted)("Origin on same-origin CORS requests, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    const seen: Record<string, string> = {};

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            const k = u.searchParams.get("k");
            if (k) seen[k] = req.headers.origin ?? "-";
            if (u.pathname === "/page.html") {
                res.writeHead(200, { "content-type": "text/html" });
                return res.end(`<!doctype html><link rel=stylesheet crossorigin href="/c.css?k=csscors"><link rel=stylesheet href="/c.css?k=css">
                    <style>@font-face{font-family:f;src:url(/f.woff2?k=font)} b{font-family:f}</style><b>x</b>
                    <script type=module src="/s.mjs?k=module"></script><script crossorigin src="/s.js?k=scriptcors"></script><script src="/s.js?k=script"></script>
                    <img crossorigin src="/i.gif?k=imgcors">
                    <script>fetch("/x?k=fetchget"); fetch("/x?k=fetchpost", { method: "POST" });</script>`);
            }
            const ct = u.pathname.endsWith(".css") ? "text/css" : u.pathname.endsWith(".woff2") ? "font/woff2" : u.pathname.endsWith("js") ? "text/javascript" : u.pathname.endsWith(".gif") ? "image/gif" : "text/plain";
            res.writeHead(200, { "content-type": ct });
            return res.end(u.pathname.endsWith(".gif") ? Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64") : "");
        });
        await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
        self = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
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

    const run = async (url: string): Promise<Record<string, string>> => {
        for (const k of Object.keys(seen)) delete seen[k];
        const page = await browser.newPage();
        await page.goto(url);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 1500)));
        await page.close();
        // By whether it was sent: direct the page's origin is the origin's,
        // proxied too once unwrapped.
        return Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v === "-" ? "-" : v === self ? "page" : v]));
    };

    it("is sent where Chromium sends it, as directly", async () => {
        const direct = await run(`${self}/page.html`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/${self.slice(7)}/page.html`);
        expect(direct).toEqual({ csscors: "page", css: "-", font: "page", module: "page", scriptcors: "page", script: "-", imgcors: "page", fetchget: "-", fetchpost: "page" });
        expect(proxied).toEqual(direct);
    }, 60_000);
});
