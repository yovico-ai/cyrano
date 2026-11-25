// @vitest-environment node
//
// A site's cookie limit, in real Chromium, direct and through the real
// proxy (spec/CookieJar.agda memEvict, purgeSite). Chromium keeps 180
// cookies per site, purged to 150 least recent first (by priority, secure
// ones protected); the runtime's memory listed every one of a script's
// 200 writes until the next document (round H).
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

describe.skipIf(!wanted)("a site's cookie limit, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/sc") { res.writeHead(200, { "set-cookie": "fm=1; Max-Age=600; Path=/", "content-type": "text/plain" }); return res.end("ok"); }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end("<!doctype html><p>page");
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
        const out = await page.evaluate(async () => {
            for (let i = 0; i < 200; i++) document.cookie = `k${i}=v; path=/; max-age=600` + (i % 7 === 0 ? "; priority=high" : "");
            const names = document.cookie.split("; ").map((p) => p.split("=")[0]);
            const all = await (window as unknown as { cookieStore: { getAll(): Promise<{ name: string }[]> } }).cookieStore.getAll();
            return { count: names.length, first: names.slice(0, 3), store: all.length, high: names.filter((n) => Number(n!.slice(1)) % 7 === 0).length };
        });
        await page.close();
        return out;
    };

    it("keeps what Chromium keeps", async () => {
        const direct = await run(`http://127.0.0.1:${port0}/page`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page`);
        expect((direct as { count: number }).count).toBeLessThan(200);
        expect(proxied).toEqual(direct);
    }, 120_000);
});
