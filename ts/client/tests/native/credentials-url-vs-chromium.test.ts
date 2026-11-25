// @vitest-environment node
//
// A subresource URL with credentials (http://user:pass@host/…), in real
// Chromium, direct and through the real proxy (spec/Fetch.agda
// credentialsBlocked; round K: the userinfo travels in the proxified path,
// so the browser saw none and the image loaded where Chromium blocks it).
// Images and frames fail as directly; nothing reaches the origin.
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

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const SCRIPT = `
window.out = (async () => {
  const other = "OTHER";
  const img = (u) => new Promise((ok) => { const i = new Image(); i.onload = () => ok("load"); i.onerror = () => ok("error"); i.src = u; });
  const out = {};
  out.cross = await img(other.replace("//", "//u:p@") + "/r.png?cred");
  out.user = await img(other.replace("//", "//u@") + "/r.png?user");
  out.plain = await img(other + "/r.png?plain");
  out.src = (() => { const i = new Image(); i.src = other.replace("//", "//u:p@") + "/r.png?read"; return i.src; })();
  return out;
})();
`;

describe.skipIf(!wanted)("credentialed subresource URLs, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let other = "";
    let proxyOrigin = "";
    const hits: string[] = [];

    beforeAll(async () => {
        upstream = createServer((q, r) => {
            const u = new URL(q.url ?? "/", "http://x");
            if (u.pathname === "/page.html") { r.writeHead(200, { "content-type": "text/html" }); return r.end("<!doctype html><head></head><body><script>" + SCRIPT.replace("OTHER", other) + "</script></body>"); }
            const a = u.searchParams.get("a");
            const h: Record<string, string> = {};
            if (a === "star") h["access-control-allow-origin"] = "*";
            if (a === "exact") h["access-control-allow-origin"] = q.headers.origin ?? "";
            if (u.searchParams.get("c")) h["access-control-allow-credentials"] = "true";
            if (u.pathname === "/r.css") { r.writeHead(200, { "content-type": "text/css", ...h }); return r.end("body { color: rgb(1, 2, 3) }"); }
            if (u.pathname === "/r.png") { hits.push(u.search); r.writeHead(200, { "content-type": "image/png", ...h }); return r.end(PNG); }
            if (u.pathname === "/f.woff2") { r.writeHead(200, { "content-type": "font/woff2", ...h }); return r.end(Buffer.alloc(16)); }
            r.writeHead(404); return r.end();
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

    it("fails as directly, nothing sent", async () => {
        hits.length = 0;
        const direct = await run(`${self}/page.html`);
        const directHits = [...hits].sort();
        hits.length = 0;
        const proxied = await run(`${proxyOrigin}/cyrano/http/${self.slice(7)}/page.html`);
        expect(direct).toMatchObject({ cross: "error", user: "error", plain: "load" });
        expect(proxied).toEqual(direct);
        expect([...hits].sort()).toEqual(directHits);
    }, 90_000);
});
