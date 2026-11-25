// @vitest-environment node
//
// Requests in mode "same-origin", in real Chromium, direct and through the
// real proxy (spec/Fetch.agda sameOriginModeFails). Through the proxy every
// target is same-origin to the browser: a worker script redirected to
// another origin ran the HTML page it landed on (telegram.me's sticker
// worker: round J), and fetch(otherOrigin, {mode: "same-origin"}) got it.
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

const PAGE = (port: number): string => `<!doctype html><script>
window.out = (async () => {
  const o = {};
  const worker = (u) => new Promise((ok) => { const w = new Worker(u); w.onmessage = (m) => ok("msg " + m.data); w.onerror = (e) => { e.preventDefault(); ok("error " + typeof e.message); }; setTimeout(() => ok("timeout"), 3000); });
  o.redirectedAway = await worker("/wr.js");
  o.redirectedHome = await worker("/wr2.js");
  const f = async (u) => { try { const r = await fetch(u, { mode: "same-origin" }); return r.status; } catch (e) { return e.name; } };
  o.fetchOther = await f("http://localhost:${port}/ok.js");
  o.fetchSelf = await f("/ok.js");
  o.fetchRedirectAway = await f("/wr.js");
  return o;
})();
</script>`;

describe.skipIf(!wanted)("same-origin mode, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/wr.js") { res.writeHead(302, { location: `http://localhost:${port0}/page` }); return res.end(); }
            if (u.pathname === "/wr2.js") { res.writeHead(302, { location: "/ok.js" }); return res.end(); }
            if (u.pathname === "/ok.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end("postMessage('ok')"); }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(PAGE(port0));
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
        const out = await page.evaluate(() => (window as unknown as { out: Promise<unknown> }).out);
        await page.close();
        return out;
    };

    it("fails as directly", async () => {
        const direct = await run(`http://127.0.0.1:${port0}/page`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page`);
        expect(direct).toMatchObject({ redirectedHome: "msg ok", fetchOther: "TypeError", fetchSelf: 200 });
        expect(proxied).toEqual(direct);
    }, 120_000);
});
