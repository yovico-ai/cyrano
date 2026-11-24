// @vitest-environment node
//
// A sandboxed frame whose document sends COEP: require-corp, in real
// Chromium, direct and through the real proxy (saguaro.com's Shopify app
// frame, round K): its origin is opaque, so the proxy's runtime is a
// cross-origin resource to it, refused without CORP — the bootstrap failed
// closed and none of its scripts ran. The runtime is served with
// Cross-Origin-Resource-Policy: cross-origin.
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

describe.skipIf(!wanted)("a sandboxed COEP frame, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/page.html") {
                res.writeHead(200, { "content-type": "text/html" });
                return res.end(`<!doctype html><script>window.out = []; addEventListener("message", (e) => window.out.push(e.data));</script>
                    <iframe sandbox="allow-scripts" src="/f?coep=require-corp"></iframe><iframe sandbox="allow-scripts" src="/f?coep=credentialless"></iframe><iframe src="/f?coep=require-corp"></iframe>`);
            }
            if (u.pathname === "/f") {
                res.writeHead(200, { "content-type": "text/html", "cross-origin-embedder-policy": u.searchParams.get("coep") ?? "" });
                return res.end(`<!doctype html><script>parent.postMessage("ran " + location.search, "*")</script>`);
            }
            res.writeHead(404);
            return res.end();
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
        await page.evaluate(() => new Promise((res) => setTimeout(res, 1500)));
        const out = await page.evaluate(() => (window as unknown as { out: string[] }).out.slice().sort());
        await page.close();
        return out;
    };

    it("runs its scripts, as directly", async () => {
        const direct = await run(`${self}/page.html`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/${self.slice(7)}/page.html`);
        expect(direct).toEqual(["ran ?coep=credentialless", "ran ?coep=require-corp", "ran ?coep=require-corp"]);
        expect(proxied).toEqual(direct);
    }, 60_000);
});
