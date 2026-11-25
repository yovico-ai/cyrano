// @vitest-environment node
//
// document.domain, in real Chromium, direct and through the real proxy
// (spec/Frames.agda domainSet, relaxed; round I: a bad value did not throw;
// round K: two sibling-subdomain frames that both set it stayed unable to
// script each other). The setter's SecurityErrors in Chromium's words, the
// value it takes, and the relaxed frames' access, as directly.
// a.localtest.me / b.localtest.me resolve to the loopback.
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
  const out = {};
  out.sets = ["", "localtest.me.", "me", "other.com", "LOCALTEST.me", " localtest.me", "a.localtest.me", "zz.localtest.me"].map((v) => {
    try { document.domain = v; return v + " ok " + document.domain; } catch (e) { return v + " " + e.name + ": " + e.message; }
  });
  out.read = document.domain;
  const f = document.createElement("iframe"); f.src = "CHILD"; document.body.append(f);
  await new Promise((r) => { f.onload = r; });
  const t = (fn) => { try { return String(fn()); } catch (e) { return e.name; } };
  out.before = t(() => f.contentWindow.secret);
  document.domain = "localtest.me";
  out.parentOnly = t(() => f.contentWindow.secret);
  f.contentWindow.postMessage("relax", "*");
  await new Promise((r) => setTimeout(r, 400));
  out.both = [t(() => f.contentWindow.secret), t(() => f.contentDocument && f.contentDocument.title), document.domain];
  return out;
})();
`;

describe.skipIf(!wanted)("document.domain, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let p0 = 0;

    beforeAll(async () => {
        upstream = createServer((q, r) => {
            const u = new URL(q.url ?? "/", "http://x");
            r.writeHead(200, { "content-type": "text/html" });
            if (u.pathname === "/child") return r.end('<title>B</title><script>window.secret = "B"; addEventListener("message", () => { document.domain = "localtest.me"; });</script>');
            return r.end("<!doctype html><body><script>" + SCRIPT.replace("CHILD", (q.headers.host ?? "").startsWith("localhost") ? "/child" : `http://b.localtest.me:${p0}/child`) + "</script></body>");
        });
        await new Promise<void>((r) => upstream.listen(0, "::", () => r()));
        p0 = (upstream.address() as { port: number }).port;
        self = `http://a.localtest.me:${p0}`;
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

    it("sets and relaxes as directly", async () => {
        const direct = await run(`${self}/page.html`) as { both: string[] };
        const proxied = await run(`${proxyOrigin}/cyrano/http/${self.slice(7)}/page.html`);
        expect(direct.both[0]).toBe("B");
        expect(proxied).toEqual(direct);
    }, 90_000);
});
