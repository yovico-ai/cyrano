// @vitest-environment node
//
// A frame of another origin navigating the top-level window without a user
// gesture, in real Chromium, direct and through the real proxy (round I:
// an ad frame's top.location = … went through proxied — every frame is
// same-origin to the top through the proxy). Chromium's framebusting rule:
// refused, with its own SecurityError; the tab stays where it is.
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

describe.skipIf(!wanted)("framebusting, in Chromium, through the proxy", () => {
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
            if (u.pathname === "/top") return res.end(`<iframe src="http://localhost:${port0}/child"></iframe><script>window.got = []; addEventListener("message", (e) => window.got.push(e.data));</script>`);
            if (u.pathname === "/child") return res.end(`<script>
                const t = "http://localhost:${port0}/busted";
                const o = {};
                for (const [k, f] of [["assignLoc", () => { top.location = t; }], ["href", () => { top.location.href = t; }], ["replace", () => top.location.replace(t)]]) {
                    try { f(); o[k] = "ok"; } catch (e) { o[k] = e.name + ": " + e.message; }
                }
                parent.postMessage(o, "*");
            </script>`);
            return res.end("busted");
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

    const run = async (url: string): Promise<{ got: unknown; path: string }> => {
        const page = await browser.newPage();
        await page.goto(url);
        await new Promise((r) => setTimeout(r, 1200));
        const got = await page.evaluate(() => (window as unknown as { got: unknown }).got);
        const path = new URL((page as unknown as { url(): string }).url()).pathname;
        await page.close();
        return { got, path };
    };

    it("is refused, as directly", async () => {
        const direct = await run(`http://127.0.0.1:${port0}/top`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/top`);
        expect(direct.path).toBe("/top");
        expect(proxied.path).toMatch(/\/top$/);
        expect(proxied.got).toEqual(direct.got);
    }, 60_000);
});
