// @vitest-environment node
//
// A frame sent to another origin that redirects back to the page's own, in
// real Chromium, direct and through the real proxy (ir.netflix.net, 2026-11-23:
// Q4's sign-in frame came back to the page's origin, and the page's onload
// read its location — proxied it threw "Blocked a frame … cross-origin").
// Once its document has committed, the frame is that document's origin.
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

const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

describe.skipIf(!wanted)("a frame redirected back to the page's origin, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let other: Server;
    let proxy: ChildProcess;
    let self = "";
    let otherOrigin = "";
    let proxyOrigin = "";

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = req.url ?? "";
            if (u.startsWith("/back")) {
                res.writeHead(200, { "content-type": "text/html" });
                return res.end("<!doctype html><p>back</p>");
            }
            if (u.startsWith("/bare")) {
                // No element: no bootstrap, no runtime (nothing of its own runs).
                res.writeHead(200, { "content-type": "text/html" });
                return res.end("<!doctype html>bare");
            }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><body><script>
window.out = {};
const frame = (k, to, read) => { const f = document.createElement("iframe");
  f.onload = () => { try { window.out[k] = read(f); } catch (e) { window.out[k] = [e.name]; } };
  f.src = "${otherOrigin}/r?to=" + to; document.body.append(f); };
frame("page", "back", (f) => [f.contentWindow.location.href, f.contentDocument && f.contentDocument.URL]);
// (A document with no runtime reads its own URL from its own realm: not read here.)
frame("bare", "bare", (f) => [f.contentWindow.location.href]);
</script></body>`);
        });
        await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
        self = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
        other = createServer((req, res) => { res.writeHead(302, { location: `${self}/${new URL(req.url ?? "/", "http://x").searchParams.get("to")}?x=1` }); res.end(); });
        await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
        otherOrigin = `http://localhost:${(other.address() as { port: number }).port}`;
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
        other?.close();
    });

    const read = async (url: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(url);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 2000)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return out;
    };

    it("is the page's own origin once back, as direct", async () => {
        const direct = await read(`${self}/p`);
        const proxied = await read(`${proxyOrigin}/cyrano/http/${self.slice(7)}/p`);
        expect(direct).toEqual({ page: [`${self}/back?x=1`, `${self}/back?x=1`], bare: [`${self}/bare?x=1`] });
        expect(proxied).toEqual(direct);
    });
});
