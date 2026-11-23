// @vitest-environment node
//
// The server-side cookie jar (spec/CookieJar.agda), in real Chromium,
// direct and through the real proxy. Every proxied site shares the proxy's
// origin: in the browser's own jar their cookies shared one site's 180 and
// were evicted (consent and session cookies on busy sites). Now the server
// keeps the jar, with Chromium's limits per site, and the browser's jar
// carries only the channel. Here, against direct:
//   * two sites with 170 cookies each keep all of them (direct: each its own 180);
//   * a response's Set-Cookie is in document.cookie at once, a script's write
//     on the very next request, an HttpOnly cookie in neither;
//   * cookieStore lists what document.cookie shows;
//   * another tab of the session sees a write without a reload;
//   * after a reload everything is still there.
//
// Runs the server binary (go/assets/cyrano) with a jar directory of its own.
// Needs it and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const binary = process.env.CYRANO_BINARY ?? resolve(root, "go/assets/cyrano");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(binary);

type Page = { goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T | Promise<T>, a?: A): Promise<T>; reload(): Promise<unknown>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(o?: object): Promise<Context>; close(): Promise<void> };

const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

describe.skipIf(!wanted)("the server-side cookie jar, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let port = 0;
    let proxyOrigin = "";
    const received: Record<string, string> = {};

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            received[`${req.headers.host}${u.pathname}`] = req.headers.cookie ?? "";
            if (u.pathname === "/set") {
                // 10 from the response, one HttpOnly.
                const sc = Array.from({ length: 10 }, (_, i) => `r${i}=${i}; Path=/; Max-Age=3600`);
                sc.push("hidden=1; Path=/; HttpOnly");
                res.writeHead(200, { "content-type": "text/plain", "set-cookie": sc });
                return res.end("ok");
            }
            if (u.pathname === "/late") {
                res.writeHead(200, { "content-type": "text/plain", "set-cookie": ["late=yes; Path=/"] });
                return res.end("ok");
            }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end("<!doctype html><body>x</body>");
        });
        await new Promise<void>((r) => upstream.listen(0, "0.0.0.0", () => r()));
        port = (upstream.address() as { port: number }).port;
        const pport = await free();
        proxyOrigin = `http://localhost:${pport}`;
        proxy = spawn(binary, ["--assets", process.env.CYRANO_ASSETS ?? resolve(root, "go/assets"), "--log-level", "warn"], {
            env: { ...process.env, CYRANO_PUBLIC_URL: proxyOrigin, CYRANO_PORT: String(pport), CYRANO_HOSTNAME: "localhost",
                CYRANO_HTTPS_ENABLED: "false", CYRANO_COOKIE_DIR: mkdtempSync(join(tmpdir(), "crn-jar-")) },
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

    // Two sites: 127.0.0.1 and 127.0.0.2 (each its own registrable "domain").
    const sites = (): string[] => [`127.0.0.1:${port}`, `127.0.0.2:${port}`];
    const at = (proxied: boolean, hostPort: string, path: string): string =>
        proxied ? `${proxyOrigin}/cyrano/http/${hostPort}${path}` : `http://${hostPort}${path}`;

    const run = async (proxied: boolean): Promise<Record<string, unknown>> => {
        const ctx = await browser.newContext();
        const out: Record<string, unknown> = {};
        for (const site of sites()) {
            const page = await ctx.newPage();
            await page.goto(at(proxied, site, "/p"));
            out[`${site} after writes`] = await page.evaluate(async () => {
                for (let i = 0; i < 160; i++) document.cookie = `c${i}=${i}; Max-Age=3600`;
                await fetch("/set");
                const names = document.cookie.split("; ").map((kv) => kv.split("=")[0]).sort();
                const store = (await cookieStore.getAll()).map((c) => c.name).sort();
                return { count: names.length, hidden: names.includes("hidden"), r9: names.includes("r9"), storeAgrees: JSON.stringify(store) === JSON.stringify(names) };
            });
            // A script's write, on the very next request.
            await page.evaluate(async () => { document.cookie = "next=1"; await fetch("/echo"); });
            const seen = received[`${site}/echo`] ?? "";
            out[`${site} upstream sees`] = { next: seen.includes("next=1"), hidden: seen.includes("hidden=1"), c0: seen.includes("c0=0"), count: seen.split("; ").length };
            // Another tab: a write here, read there without a reload.
            const other = await ctx.newPage();
            await other.goto(at(proxied, site, "/p"));
            await page.evaluate(() => { document.cookie = "tab=1"; });
            await new Promise((r) => setTimeout(r, 300));
            out[`${site} other tab`] = await other.evaluate(() => document.cookie.includes("tab=1"));
            // A response's cookie in another tab: there at once.
            await other.evaluate(async () => { await fetch("/late"); });
            out[`${site} late at once`] = await other.evaluate(() => document.cookie.includes("late=yes"));
            await other.close();
            await page.reload();
            out[`${site} after reload`] = await page.evaluate(() => document.cookie.split("; ").length);
            await page.close();
        }
        await ctx.close();
        return out;
    };

    it("each site keeps its own cookies, seen as directly", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        // Direct: 160 + 10 visible, + next + tab + late (and HttpOnly hidden).
        expect(direct[`127.0.0.1:${port} after writes`]).toEqual({ count: 170, hidden: false, r9: true, storeAgrees: true });
        expect(proxied).toEqual(direct);
    }, 120_000);
});
