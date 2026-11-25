// @vitest-environment node
//
// Navigation API interception, in real Chromium, direct and through the real
// proxy (spec/Route.agda canIntercept; round K: through the proxy every
// destination is same-origin to the browser, so a link to another site was
// interceptable — an SPA router kept it in-page). canIntercept and
// intercept()'s SecurityError as directly.
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

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

const SCRIPT = `
window.out = (async () => {
  const other = "OTHER";
  const res = [];
  navigation.addEventListener("navigate", (e) => {
    let err = "-";
    try { if (!e.canIntercept) e.intercept({ handler: async () => {} }); } catch (x) { err = x.name + ": " + x.message; }
    res.push([e.destination.url, e.canIntercept, err]);
    e.preventDefault();
  });
  for (const u of [other + "/x?link", "/b?y", "#h", location.origin.replace("127.0.0.1", "localhost") + "/z"]) {
    try { location.href = u; } catch (e) { res.push([u, "throw " + e.name]); }
  }
  await new Promise((r) => setTimeout(r, 300));
  return res;
})();
`;

describe.skipIf(!wanted)("navigation interception, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let other = "";
    let proxyOrigin = "";

    beforeAll(async () => {
        upstream = createServer((_q, r) => {
            r.writeHead(200, { "content-type": "text/html" });
            return r.end("<!doctype html><body><script>" + SCRIPT.replace("OTHER", other) + "</script></body>");
        });
        await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
        const p0 = (upstream.address() as { port: number }).port;
        self = `http://127.0.0.1:${p0}`;
        other = `http://localhost:${p0}`;
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

    const run = async (url: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(url);
        const out = await page.evaluate(() => (window as unknown as { out: Promise<unknown> }).out);
        await page.close();
        return out;
    };

    it("intercepts as directly", async () => {
        const direct = await run(`${self}/page.html`) as unknown[][];
        const proxied = await run(`${proxyOrigin}/cyrano/http/${self.slice(7)}/page.html`);
        expect(direct.map((r) => r[1])).toEqual([false, true, true, false]);
        expect(proxied).toEqual(direct);
    }, 90_000);
});
