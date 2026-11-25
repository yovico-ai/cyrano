// @vitest-environment node
//
// CORS-mode element requests other than scripts, in real Chromium, direct
// and through the real proxy (spec/Orb.agda corsElementDest; Go
// proxy/orb.go). Through the proxy every request is same-origin to the
// browser, so only a script's was checked: a <link rel=stylesheet
// crossorigin> without Access-Control-Allow-Origin loaded (its rules
// readable), a use-credentials image answered ACAO "*" loaded, a font of
// another origin without ACAO was used. Each load or error as directly.
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
  const ev = (el) => new Promise((ok) => { el.onload = () => ok("load"); el.onerror = () => ok("error"); setTimeout(() => ok("timeout"), 4000); });
  const css = (q, co) => { const l = document.createElement("link"); l.rel = "stylesheet"; if (co) l.crossOrigin = co; l.href = other + "/r.css?" + q; const p = ev(l); document.head.append(l); return p; };
  const img = (q, co) => { const i = new Image(); if (co) i.crossOrigin = co; const p = ev(i); i.src = other + "/r.png?" + q; return p; };
  const out = {};
  out.cssNoAcao = await css("a=none", "anonymous");
  out.cssAcao = await css("a=star", "anonymous");
  out.cssPlain = await css("a=none", null);
  out.imgCredStar = await img("a=star", "use-credentials");
  out.imgCredExact = await img("a=exact&c=1", "use-credentials");
  out.imgAnonStar = await img("a=star", "anonymous");
  out.imgAnonNone = await img("a=none", "anonymous");
  out.imgPlain = await img("a=none", null);
  const font = async (q) => { const f = new FontFace("F" + q.length, "url(" + other + "/f.woff2?" + q + ")"); try { await f.load(); return "load"; } catch (e) { return "error"; } };
  out.fontNone = await font("a=none"); out.fontStar = await font("a=star");
  return out;
})();
`;

describe.skipIf(!wanted)("cors-mode element requests, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let other = "";
    let proxyOrigin = "";

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
            if (u.pathname === "/r.png") { r.writeHead(200, { "content-type": "image/png", ...h }); return r.end(PNG); }
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

    it("each element loads or fails as directly", async () => {
        const direct = await run(`${self}/page.html`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/${self.slice(7)}/page.html`);
        expect(direct).toMatchObject({ cssNoAcao: "error", cssAcao: "load", cssPlain: "load", imgCredStar: "error", imgCredExact: "load", imgAnonStar: "load", imgAnonNone: "error", imgPlain: "load" });
        expect(proxied).toEqual(direct);
    }, 90_000);
});
