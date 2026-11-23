// @vitest-environment node
//
// A worker's location, in real Chromium, direct and through the real proxy
// (thangs.com, 2026-11-23: Turbopack starts its workers with
// "#params=…" and reads its chunk list from location.href's fragment —
// "Missing worker bootstrap config"). A worker the server serves and one
// made of a page's blob: script read their own URL, fragment included, and
// their origin, as directly.
//
// Runs the server binary (go/assets/cyrano: ./go/scripts/build.sh) on a
// free port. Needs it and Playwright's Chromium; `make browser-check`.

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

const PAGE = `<!doctype html><body><script>
window.out = {};
const ask = (k, w) => { w.onmessage = (e) => { window.out[k] = e.data; }; };
ask("served", new Worker("/w.js#params=abc"));
const b = URL.createObjectURL(new Blob(["postMessage([location.href, location.hash, location.origin])"], { type: "text/javascript" }));
ask("blob", new Worker(b + "#params=xyz"));
</script></body>`;

const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

describe.skipIf(!wanted)("a worker's location, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            if ((req.url ?? "").startsWith("/w.js")) {
                res.writeHead(200, { "content-type": "text/javascript" });
                return res.end("postMessage([location.href, location.hash, location.origin])");
            }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(PAGE);
        });
        await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
        self = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
        const port = await free();
        proxyOrigin = `http://localhost:${port}`;
        proxy = spawn(binary, ["--assets", resolve(root, "go/assets"), "--log-level", "warn"], {
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

    const read = async (url: string): Promise<string> => {
        const page = await browser.newPage();
        await page.goto(url);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 1500)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return JSON.stringify(Object.fromEntries(Object.entries(out as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "UUID");
    };

    it("reads as direct", async () => {
        const direct = await read(`${self}/p`);
        const proxied = await read(`${proxyOrigin}/cyrano/http/${self.slice(7)}/p`);
        expect(JSON.parse(direct)).toEqual({
            served: [`${self}/w.js#params=abc`, "#params=abc", self],
            blob: [`blob:${self}/UUID#params=xyz`, "#params=xyz", self],
        });
        expect(proxied).toBe(direct);
    });
});
