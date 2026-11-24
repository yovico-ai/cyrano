// @vitest-environment node
//
// fetch's redirect modes across origins, in real Chromium, direct and
// through the real proxy (round I: a cross-origin redirect:"manual" fetch
// whose 302 passes the CORS check failed proxied — the runtime checked the
// opaque redirect's headers, which it shows none of — where Chromium gives
// an opaque redirect). The proxy CORS-checks the redirect; the runtime
// hands an opaque redirect over; no-cors + manual fails as natively.
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

describe.skipIf(!wanted)("fetch redirect modes, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            const other = `http://localhost:${port0}`;
            if (u.pathname === "/redir") { res.writeHead(302, { location: "/x", ...(u.searchParams.has("cors") ? { "access-control-allow-origin": "*" } : {}) }); return res.end(); }
            if (u.pathname === "/x") { res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }); return res.end("x"); }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<script>
                const r = (p) => p.then((x) => [x.type, x.status], (e) => e.name + ": " + e.message);
                window.out = Promise.all([
                    r(fetch("${other}/redir", { redirect: "manual" })),
                    r(fetch("${other}/redir", { redirect: "manual", mode: "no-cors" })),
                    r(fetch("${other}/redir")),
                    r(fetch("/redir", { redirect: "manual" })),
                    r(fetch("${other}/redir?cors", { redirect: "manual" })),
                    r(fetch("${other}/redir?cors", { redirect: "manual", mode: "no-cors" })),
                ]);
            </script>`);
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

    const run = async (url: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(url);
        const out = await page.evaluate(() => (window as unknown as { out: Promise<unknown> }).out);
        await page.close();
        return out;
    };

    it("answers as directly", async () => {
        const direct = await run(`http://127.0.0.1:${port0}/top`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/top`);
        const fail = "TypeError: Failed to fetch";
        // A manual redirect is CORS-checked (no ACAO: a network error) and
        // then handed over opaque; no-cors with manual fails.
        expect(direct).toEqual([fail, fail, fail, ["opaqueredirect", 0], ["opaqueredirect", 0], fail]);
        expect(proxied).toEqual(direct);
        expect(proxied).toEqual(direct);
    }, 60_000);
});
