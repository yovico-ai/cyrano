// @vitest-environment node
//
// CSP connect-src probes of data:, in real Chromium, direct and through
// the real proxy (spec/Csp.agda readable: the connect policy is not given
// data:, the runtime decodes a data: worker script itself). A page's
// `fetch("data:,")` under connect-src 'self' succeeded proxied, with no
// violation: Cloudflare's challenge probes exactly that (round K).
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

const CSP = "connect-src 'self'; script-src 'self' 'unsafe-inline'; worker-src data: blob:";
const PAGE = `<!doctype html><script>
window.out = (async () => {
  const o = { violations: [] };
  document.addEventListener("securitypolicyviolation", (e) => o.violations.push(e.effectiveDirective + " " + e.blockedURI));
  try { const r = await fetch("data:,"); o.fetch = r.status; } catch (e) { o.fetch = e.name; }
  o.xhr = await new Promise((ok) => { const x = new XMLHttpRequest(); x.open("GET", "data:text/plain,hi"); x.onload = () => ok("load"); x.onerror = () => ok("error"); x.send(); });
  o.worker = await new Promise((ok) => { const w = new Worker("data:text/javascript," + encodeURIComponent("postMessage(self.location.protocol + ' ' + (1 + 1))"));
    w.onmessage = (m) => ok(m.data); w.onerror = () => ok("error"); setTimeout(() => ok("timeout"), 3000); });
  await new Promise((r) => setTimeout(r, 300));
  o.violations.sort();
  return o;
})();
</script>`;

describe.skipIf(!wanted)("CSP connect-src and data:, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((_req, res) => {
            res.writeHead(200, { "content-type": "text/html", "content-security-policy": CSP });
            return res.end(PAGE);
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

    it("refuses data: as directly", async () => {
        const direct = await run(`http://127.0.0.1:${port0}/page`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page`);
        expect(direct).toMatchObject({ fetch: "TypeError", xhr: "error", worker: "data: 2" });
        expect(proxied).toEqual(direct);
    }, 120_000);
});
