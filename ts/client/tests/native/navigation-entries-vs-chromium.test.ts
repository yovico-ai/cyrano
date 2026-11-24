// @vitest-environment node
//
// The Navigation API's entries across sites, in real Chromium, direct and
// through the real proxy (round I: navigation.entries() on the next site
// listed the previous site's entries, their URLs and queries — through the
// proxy every entry is same-origin to the browser). A page sees the
// contiguous run of its own origin's entries: their URLs, the current
// index, canGoBack, as directly.
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

describe.skipIf(!wanted)("navigation.entries() across sites, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            res.writeHead(200, { "content-type": "text/html" });
            if (u.pathname === "/b") {
                return res.end(`<!doctype html><script>
                    window.out = { urls: navigation.entries().map((e) => new URL(e.url).pathname + new URL(e.url).search), index: navigation.currentEntry.index, back: navigation.canGoBack, fwd: navigation.canGoForward };
                </script>`);
            }
            return res.end("<p>a");
        });
        await new Promise<void>((r) => upstream.listen(0, "0.0.0.0", () => r()));
        port0 = (upstream.address() as { port: number }).port;
        self = `http://127.0.0.1:${port0}`;
        void self;
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

    const run = async (proxied: boolean): Promise<unknown> => {
        const at = (host: string, path: string): string => proxied ? `${proxyOrigin}/cyrano/http/${host}:${port0}${path}` : `http://${host}:${port0}${path}`;
        type P = { goto(u: string): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; evaluate<T>(f: (a: string) => T, a?: string): Promise<T>; waitForURL(u: RegExp): Promise<void> };
        const ctx = await (browser as unknown as { newContext(): Promise<{ newPage(): Promise<P>; close(): Promise<void> }> }).newContext();
        const p = await ctx.newPage();
        await p.goto(at("127.0.0.1", "/a?secret=A1"));
        await p.evaluate(() => history.pushState({}, "", "?secret=A2"));
        await p.evaluate((u) => { location.href = u; }, at("localhost", "/b?x=1"));
        await p.waitForURL(/\/b\?x=1/);
        await p.waitForTimeout(300);
        const out = await p.evaluate(() => (window as unknown as { out: unknown }).out);
        await ctx.close();
        return out;
    };

    it("lists the page's own entries only, as directly", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        expect(direct).toEqual({ urls: ["/b?x=1"], index: 0, back: false, fwd: false });
        expect(proxied).toEqual(direct);
    }, 60_000);
});
