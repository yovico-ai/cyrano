// @vitest-environment node
//
// document.featurePolicy, in real Chromium, direct and through the real
// proxy (spec/Permissions.agda allows / allowlist; the server's table in
// config `pp`). The browser answered for the proxy's origin and the
// translated header: allowsFeature(f, location.origin) false on every
// page, getAllowlistForFeature naming the proxy, a feature the policy
// gives only another origin allowed to the page (round K).
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

const HEADERS: Record<string, string | null> = {
    none: null,
    pp: 'geolocation=(), camera=(self), fullscreen=("http://localhost:PORT"), microphone=*, payment=(self "https://*.pay.example" "https://a.example"), autoplay=("*")',
    bad: "geolocation=(, camera",
};
const SCRIPT = `window.out = (() => { const fp = document.featurePolicy; const r = {};
  for (const f of ["geolocation", "camera", "fullscreen", "microphone", "payment", "autoplay", "join-ad-interest-group", "nosuch"]) {
    r[f] = [fp.allowsFeature(f), fp.allowsFeature(f, location.origin), fp.allowsFeature(f, "http://localhost:PORT"), fp.allowsFeature(f, "https://x.pay.example"), fp.allowsFeature(f, "notanorigin"), JSON.stringify(fp.getAllowlistForFeature(f))].join(" ");
  }
  r.allowed = fp.allowedFeatures().join(",");
  r.features = fp.features().length;
  return r; })();`;

describe.skipIf(!wanted)("document.featurePolicy, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const k = new URL(req.url ?? "/", "http://x").searchParams.get("h") ?? "none";
            const h: Record<string, string> = { "content-type": "text/html" };
            const v = HEADERS[k];
            if (v) h["permissions-policy"] = v.replace("PORT", String(port0));
            res.writeHead(200, h);
            return res.end("<!doctype html><script>" + SCRIPT.split("PORT").join(String(port0)) + "</script>");
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
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return out;
    };

    it("answers as directly", async () => {
        for (const k of Object.keys(HEADERS)) {
            const direct = await run(`http://127.0.0.1:${port0}/page?h=${k}`);
            const proxied = await run(`${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page?h=${k}`);
            expect(proxied, k).toEqual(direct);
        }
    }, 120_000);
});
