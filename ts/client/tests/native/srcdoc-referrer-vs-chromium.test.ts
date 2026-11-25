// @vitest-environment node
//
// A srcdoc frame's document.referrer, in real Chromium, direct and through
// the real proxy (spec/Referrer.agda srcdocReferrer; round J: it read "").
// Its parent's URL by the parent's policy (header or <meta name=referrer>),
// for a srcdoc in the server's markup and one a script sets.
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
  await new Promise((r) => setTimeout(r, 300));
  const f = document.createElement("iframe"); f.srcdoc = "<script>parent.__dyn = document.referrer<\\/script>"; document.body.append(f);
  await new Promise((r) => setTimeout(r, 400));
  return { markup: window.__mk, dynamic: window.__dyn };
})();
`;

describe.skipIf(!wanted)("a srcdoc frame referrer, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";

    beforeAll(async () => {
        upstream = createServer((q, r) => {
            const u = new URL(q.url ?? "/", "http://x");
            const pol = u.searchParams.get("p");
            const meta = u.searchParams.get("m");
            r.writeHead(200, { "content-type": "text/html", ...(pol ? { "referrer-policy": pol } : {}) });
            return r.end("<!doctype html><head>" + (meta ? `<meta name="referrer" content="${meta}">` : "") + "</head><body>" +
                '<iframe srcdoc="<script>parent.__mk = document.referrer</script>"></iframe><script>' + SCRIPT + "</script></body>");
        });
        await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
        const p0 = (upstream.address() as { port: number }).port;
        self = `http://127.0.0.1:${p0}`;
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

    it("gives the parent URL by its policy, as directly", async () => {
        for (const q of ["", "p=unsafe-url", "p=no-referrer", "p=same-origin", "m=unsafe-url", "p=no-referrer&m=no-referrer-when-downgrade", "m=never"]) {
            const direct = await run(`${self}/dir/page.html?x=1&${q}`);
            const proxied = await run(`${proxyOrigin}/cyrano/http/${self.slice(7)}/dir/page.html?x=1&${q}`);
            expect(proxied, q).toEqual(direct);
        }
    }, 120_000);
});
