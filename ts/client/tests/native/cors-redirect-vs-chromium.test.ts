// @vitest-environment node
//
// A same-origin fetch / XHR redirected to another origin, in real Chromium,
// direct and through the real proxy (spec/Fetch.agda corsOrigin). Natively
// the redirected request is a cross-origin one there: CORS-checked by the
// page's origin, credentials by the page's mode, its response of type
// "cors" showing only the headers it exposes. Through the proxy the browser
// followed it as same-origin and the page read any answer.
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

const PAGE = (): string => `<!doctype html><script>
window.out = (async () => {
  const o = {};
  const away = (q) => "/r?" + q;
  const f = async (q, init) => {
    try {
      const r = await fetch(away(q), init);
      return { type: r.type, redirected: r.redirected, url: r.url, secret: r.headers.get("x-secret"), shown: r.headers.get("x-shown"), body: await r.text() };
    } catch (e) { return e.name; }
  };
  o.none = await f("");
  o.star = await f("acao=*");
  o.starExposed = await f("acao=*&expose=x-shown");
  o.starIncluded = await f("acao=*", { credentials: "include" });
  o.echoIncluded = await f("acao=echo&acac=true", { credentials: "include" });
  o.echoNoAcac = await f("acao=echo", { credentials: "include" });
  o.home = await f("home=1");
  const x = (q, cred) => new Promise((ok) => {
    const r = new XMLHttpRequest();
    r.open("GET", away(q));
    r.withCredentials = !!cred;
    r.onload = () => ok({ status: r.status, url: r.responseURL, secret: r.getResponseHeader("x-secret"), shown: r.getResponseHeader("x-shown"), all: r.getAllResponseHeaders().includes("x-secret"), body: r.responseText });
    r.onerror = () => ok("error " + r.status);
    r.send();
  });
  o.xhrNone = await x("");
  o.xhrStar = await x("acao=*&expose=x-shown");
  o.xhrStarCred = await x("acao=*", true);
  return o;
})();
</script>`;

describe.skipIf(!wanted)("a same-origin request redirected to another origin, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/r") {
                const home = u.searchParams.get("home") === "1";
                res.writeHead(302, { location: (home ? "" : `http://localhost:${port0}`) + "/data?" + u.searchParams.toString() });
                return res.end();
            }
            if (u.pathname === "/data") {
                const h: Record<string, string> = { "content-type": "text/plain", "x-secret": "s", "x-shown": "v" };
                const acao = u.searchParams.get("acao");
                if (acao) h["access-control-allow-origin"] = acao === "echo" ? String(req.headers.origin) : acao;
                if (u.searchParams.get("acac")) h["access-control-allow-credentials"] = "true";
                const ex = u.searchParams.get("expose");
                if (ex) h["access-control-expose-headers"] = ex;
                res.writeHead(200, h);
                return res.end("origin=" + (req.headers.origin ?? "-"));
            }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(PAGE());
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

    it("is CORS-checked there, as directly", async () => {
        const direct = await run(`http://127.0.0.1:${port0}/page`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page`);
        expect(direct).toMatchObject({ none: "TypeError", starIncluded: "TypeError", echoNoAcac: "TypeError", xhrNone: "error 0", xhrStarCred: "error 0" });
        expect(direct).toMatchObject({ star: { type: "cors", secret: null }, starExposed: { shown: "v" }, home: { type: "basic", secret: "s" } });
        expect(proxied).toEqual(direct);
    }, 120_000);
});
