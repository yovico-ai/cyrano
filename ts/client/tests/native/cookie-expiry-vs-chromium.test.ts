// @vitest-environment node
//
// A cookie's expiry as cookieStore reads it, in real Chromium, direct and
// through the real proxy (spec/CookieJar.agda: the jar's clock in µs, the
// channel's msText). Chromium dates a Max-Age expiry from its creation in
// microseconds; the jar kept whole ms, so a response's cookie read a
// whole-ms `expires` (round J), and a script's lost its fraction with the
// next document.
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

describe.skipIf(!wanted)("a cookie's expiry, in Chromium, through the proxy", () => {
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

    const run = async (url: string): Promise<Record<string, unknown>> => {
        const page = await browser.newPage();
        await page.goto(url);
        const first = await page.evaluate(async () => {
            await fetch("sc");
            document.cookie = "jm=1; max-age=600";
            const g = async (n: string): Promise<number> => ((await (window as unknown as { cookieStore: { get(n: string): Promise<{ expires: number }> } }).cookieStore.get(n)).expires);
            const t = Date.now();
            return { fm: await g("fm"), jm: await g("jm"), t };
        });
        await page.reload();
        const after = await page.evaluate(async () => {
            const g = async (n: string): Promise<number> => ((await (window as unknown as { cookieStore: { get(n: string): Promise<{ expires: number }> } }).cookieStore.get(n)).expires);
            return { fm: await g("fm"), jm: await g("jm") };
        });
        await page.close();
        const f = first as { fm: number; jm: number; t: number };
        // the shape of each value: µs precision (a fraction, unless its µs are 0), about now + 600 s, and kept across the reload
        const shape = (v: number): string => (Math.abs(v - f.t - 600_000) < 5_000 ? "now+600s" : "off:" + v) + (Number.isInteger(v) ? "" : ",µs");
        return { fm: shape(f.fm), jm: shape(f.jm), fmKept: after.fm === f.fm, jmKept: after.jm === f.jm };
    };

    it("keeps microseconds, as directly", async () => {
        // (a value whose µs are 0 reads whole: one in a thousand; tried again)
        let direct: Record<string, unknown> = {}, proxied: Record<string, unknown> = {};
        for (let i = 0; i < 3; i++) {
            direct = await run(`http://127.0.0.1:${port0}/page`);
            proxied = await run(`${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page`);
            if (direct.fm === "now+600s,µs" && direct.jm === "now+600s,µs" && proxied.fm === "now+600s,µs" && proxied.jm === "now+600s,µs") break;
        }
        expect(direct).toEqual({ fm: "now+600s,µs", jm: "now+600s,µs", fmKept: true, jmKept: true });
        expect(proxied).toEqual(direct);
    }, 120_000);
});
