// @vitest-environment node
//
// 'strict-dynamic' with a hash, in real Chromium, direct and through the
// real proxy (devforum.okta.com, round H: Discourse's data: and blob: module
// stubs, imported by a trusted script, were refused proxied). A hash makes
// the proxy replace the source list (the rewritten inline scripts cannot
// match it); what 'strict-dynamic' admitted — any script a trusted one
// loads — must still load: through the proxy every http(s) URL is the
// proxy's, and data: and blob: are added (spec/Csp.agda unhash).
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

describe.skipIf(!wanted)("'strict-dynamic' with a hash, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u === "/page.html") {
                res.writeHead(200, { "content-type": "text/html", "content-security-policy": "script-src 'nonce-abc' 'strict-dynamic' 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='" });
                return res.end(`<!doctype html><body><script nonce="abc" type="module">
                    window.out = {};
                    try { window.out.data = (await import("data:text/javascript,export default 7")).default; } catch (e) { window.out.data = e.name; }
                    const b = URL.createObjectURL(new Blob(["export default 8"], { type: "text/javascript" }));
                    try { window.out.blob = (await import(b)).default; } catch (e) { window.out.blob = e.name; }
                    try { window.out.url = (await import("${self}/m.mjs")).default; } catch (e) { window.out.url = e.name; }
                </script></body>`);
            }
            if (u === "/m.mjs") {
                res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" });
                return res.end(`export default 9;`);
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
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return out;
    };

    it("what a trusted script imports loads, as directly", async () => {
        const direct = await run(`${self}/page.html`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/${self.slice(7)}/page.html`);
        expect(direct).toEqual({ data: 7, blob: 8, url: 9 });
        expect(proxied).toEqual(direct);
    }, 60_000);
});
