// @vitest-environment node
//
// Timing entries that name a URL, in real Chromium, direct and through the
// real proxy (round I: PerformanceElementTiming.url and the LCP entry's url
// were the proxified URLs; RUM libraries report them; round K: a
// hashchange's oldURL / newURL too; an entry looked up by the page's URL,
// getEntriesByName — a PerformanceObserver's list found none, a marked
// script's URL none either). Read as directly.
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

describe.skipIf(!wanted)("timing entry URLs, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/s.js") {
                res.writeHead(200, { "content-type": "text/javascript" });
                return res.end("window.sjs = 1;");
            }
            if (u.pathname === "/big.svg") {
                res.writeHead(200, { "content-type": "image/svg+xml", "timing-allow-origin": "*" });
                return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="red"/></svg>');
            }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><img src="/big.svg" elementtiming="hero"><div elementtiming="bg" style="width:300px;height:200px;background:url(/big.svg?b)"></div><script src="/s.js"></script><script>
                window.out = new Promise((done) => {
                    const got = {};
                    new PerformanceObserver((l) => { for (const e of l.getEntries()) got[e.identifier] = new URL(e.url).pathname + new URL(e.url).search; }).observe({ type: "element", buffered: true });
                    new PerformanceObserver((l) => { for (const e of l.getEntries()) got.lcp = e.url ? new URL(e.url).pathname + new URL(e.url).search : ""; }).observe({ type: "largest-contentful-paint", buffered: true });
                    addEventListener("hashchange", (e) => { got.hc = [new URL(e.oldURL).pathname + new URL(e.oldURL).hash, new URL(e.newURL).pathname + new URL(e.newURL).hash]; });
                    setTimeout(() => { location.hash = "#two"; }, 300);
                    // entries looked up by the page's URL (round K: an observer's list found none)
                    new PerformanceObserver((l) => { const n = l.getEntriesByName(location.origin + "/big.svg").length; if (n) got.obs = n; }).observe({ type: "resource", buffered: true });
                    performance.mark("m");
                    setTimeout(() => {
                        got.js = performance.getEntriesByName(location.origin + "/s.js").length;
                        got.jsTyped = performance.getEntriesByName(location.origin + "/s.js", "resource").length;
                        got.jsOther = performance.getEntriesByName(location.origin + "/s.js", "mark").length;
                        got.mark = performance.getEntriesByName("m").length;
                    }, 1000);
                    setTimeout(() => done(got), 1500);
                });
            </script>`);
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

    const run = async (url: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(url);
        const out = await page.evaluate(() => (window as unknown as { out: Promise<unknown> }).out);
        await page.close();
        return out;
    };

    it("names the page's URLs, as directly", async () => {
        const direct = await run(`${self}/page.html`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/${self.slice(7)}/page.html`);
        expect(direct).toMatchObject({ hero: "/big.svg", bg: "/big.svg?b", hc: ["/page.html", "/page.html#two"], obs: 1, js: 1, jsTyped: 1, jsOther: 0, mark: 1 });
        expect(proxied).toEqual(direct);
    }, 60_000);
});
