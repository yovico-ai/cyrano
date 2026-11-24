// @vitest-environment node
//
// Clear-Site-Data, in real Chromium, direct and through the real proxy
// (round K: one site's sign-out cleared every proxied site's storage and
// the session cookie, so the whole server jar). Two sites, a = 127.0.0.1
// and b = localhost (both trustworthy over http): b answers a fetch with
// Clear-Site-Data "cookies", "storage". a keeps its cookie and its
// localStorage; b's cookies are gone, its new one too (spec/ClearSiteData).
// (b's own storage is not cleared proxied: a known gap.)
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

describe.skipIf(!wanted)("Clear-Site-Data, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/csd") {
                res.writeHead(200, { "content-type": "text/plain", "set-cookie": "fresh=1; Path=/", "clear-site-data": '"cookies", "storage"' });
                return res.end("ok");
            }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end("<p>page");
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

    const run = async (proxied: boolean): Promise<string[]> => {
        const at = (host: string, path: string): string => proxied ? `${proxyOrigin}/cyrano/http/${host}:${port0}${path}` : `http://${host}:${port0}${path}`;
        type P = { goto(u: string): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; evaluate<T>(f: () => T): Promise<T> };
        const ctx = await (browser as unknown as { newContext(): Promise<{ newPage(): Promise<P>; close(): Promise<void> }> }).newContext();
        const p = await ctx.newPage();
        const read = (): Promise<string> => p.evaluate(() => document.cookie + " | " + localStorage.getItem("k"));
        await p.goto(at("127.0.0.1", "/a"));
        await p.evaluate(() => { document.cookie = "KA=1; path=/"; localStorage.setItem("k", "A"); });
        await p.goto(at("localhost", "/b"));
        await p.evaluate(() => { document.cookie = "KB=1; path=/"; localStorage.setItem("k", "B"); });
        await p.evaluate(async () => { await fetch("/csd"); });
        await p.waitForTimeout(300);
        await p.goto(at("localhost", "/b"));
        const b = await p.evaluate(() => document.cookie);
        await p.goto(at("127.0.0.1", "/a"));
        const a = await read();
        await ctx.close();
        return ["a: " + a, "b cookies: " + b];
    };

    it("clears the one site, as directly", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        expect(direct).toEqual(["a: KA=1 | A", "b cookies: "]);
        expect(proxied).toEqual(direct);
    }, 90_000);
});
