// @vitest-environment node
//
// CORS preflights, in real Chromium, direct and through the real proxy
// (spec/Preflight.agda; Go proxy/preflight.go; the runtime's Crn-A).
// Through the proxy every request is same-origin to the browser, so none
// was preflighted: a cross-origin PUT or JSON POST went straight to the
// origin — one it refuses at the preflight acted there — and the origin
// never saw an OPTIONS (Alia's Cloudflare-fronted API on birdies.com). The
// upstream records what reaches it: the same requests in the same order
// (preflights with their method, header names and Chrome's header order;
// no request after a refused preflight; a cached one not asked again), and
// the page sees the same outcomes.
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
  const out = {};
  const f = async (c, q, init) => { try { const r = await fetch(other + "/api?c=" + c + (q || ""), init); out[c] = r.status; } catch (e) { out[c] = e.name; } };
  await f("simple", "", { method: "POST", body: "x" });
  await f("put", "", { method: "PUT" });
  await f("hdrs", "", { method: "POST", headers: { "X-Foo": "1", "x-alpha": "2" } });
  await f("json", "", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  await f("plainparam", "", { method: "POST", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "x" });
  await f("blobjson", "", { method: "POST", body: new Blob(["{}"], { type: "application/json" }) });
  await f("acceptparen", "", { headers: { Accept: "a(b" } });
  await f("range", "", { headers: { Range: "bytes=0-10" } });
  await f("rangebad", "", { headers: { Range: "bytes=10-5" } });
  await f("noacao", "&pre=noacao", { method: "PUT" });
  await f("st302", "&st=302", { method: "PUT" });
  await f("st200", "&st=200", { method: "PUT" });
  await f("amLower", "&am=put", { method: "PUT" });
  await f("credstar", "&pre=star&am=*", { method: "PUT", credentials: "include" });
  await f("credok", "&pre=cred", { method: "PUT", credentials: "include" });
  await f("amstar", "&pre=star&am=*", { method: "PUT" });
  await f("authstar", "&pre=star&ah=*", { method: "POST", headers: { Authorization: "x" } });
  await f("ahmissing", "&ah=x-foo", { method: "POST", headers: { "X-Bar": "1" } });
  await f("amBadToken", "&am=" + encodeURIComponent("PUT, a b"), { method: "PUT" });
  await f("cache1", "&ma=60", { method: "PUT" }); await f("cache1", "&ma=60", { method: "PUT" });
  await f("cache0", "&ma=0", { method: "PUT" }); await f("cache0", "&ma=0", { method: "PUT" });
  await f("cacheHdr", "&ma=60&ah=x-foo,x-bar", { method: "POST", headers: { "X-Foo": "1" } }); await f("cacheHdr", "&ma=60&ah=x-foo,x-bar", { method: "POST", headers: { "X-Bar": "1" } });
  const xhr = (c, setup, body) => new Promise((ok) => { const x = new XMLHttpRequest(); x.open("POST", other + "/api?c=" + c); setup(x); x.onloadend = () => { out[c] = x.status; ok(); }; x.send(body); });
  await xhr("xhrHdr", (x) => x.setRequestHeader("X-Foo", "1"), "data");
  await xhr("xhrUpload", (x) => { x.upload.onprogress = () => {}; }, "data");
  await xhr("xhrUploadListener", (x) => { x.upload.addEventListener("load", () => {}); }, "data");
  await xhr("xhrPlain", () => {}, "data");
  // a blob: worker's requests: its origin is its creator's (the blob URL's)
  await new Promise((ok) => {
    const src = "fetch('" + other + "/api?c=blobWorker').then((r) => postMessage(r.status), (e) => postMessage(e.name)); fetch('" + other + "/api?c=blobWorkerPut', { method: 'PUT' }).catch(() => {});";
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    w.onmessage = (m) => { out.blobWorker = m.data; setTimeout(ok, 300); };
    w.onerror = () => { out.blobWorker = "error"; ok(); };
  });
  return out;
})();
`;

describe.skipIf(!wanted)("CORS preflights, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let other = "";
    let proxyOrigin = "";
    const log: string[] = [];

    beforeAll(async () => {
        upstream = createServer((q, r) => {
            const u = new URL(q.url ?? "/", "http://x");
            if (u.pathname === "/page.html") { r.writeHead(200, { "content-type": "text/html" }); return r.end("<!doctype html><body><script>" + SCRIPT.replace("OTHER", other) + "</script></body>"); }
            const c = u.searchParams.get("c") ?? "";
            const names = q.rawHeaders.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase());
            log.push([c, q.method, "acrm=" + (q.headers["access-control-request-method"] ?? "-"), "acrh=" + (q.headers["access-control-request-headers"] ?? "-"),
                "origin=" + (q.headers.origin ?? "-"), q.headers.cookie ? "cookie" : "", q.method === "OPTIONS" ? names.filter((n) => n !== "host" && n !== "connection").join(" ") : ""].join(" "));
            const o = q.headers.origin ?? "*";
            const pre = u.searchParams.get("pre") ?? "ok";
            if (q.method === "OPTIONS") {
                const h: Record<string, string> = {};
                if (pre !== "noacao") h["access-control-allow-origin"] = pre === "star" ? "*" : o;
                if (pre === "cred") h["access-control-allow-credentials"] = "true";
                h["access-control-allow-methods"] = u.searchParams.get("am") ?? "PUT, PATCH, DELETE";
                h["access-control-allow-headers"] = u.searchParams.get("ah") ?? "x-foo, x-alpha, content-type, accept, range";
                const ma = u.searchParams.get("ma");
                if (ma) h["access-control-max-age"] = ma;
                r.writeHead(Number(u.searchParams.get("st") ?? 204), h);
                return r.end();
            }
            r.writeHead(200, { "access-control-allow-origin": o, "access-control-allow-credentials": "true" });
            return r.end("ok");
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

    const run = async (url: string): Promise<{ out: unknown; log: string[] }> => {
        log.length = 0;
        const page = await browser.newPage();
        await page.goto(url);
        const out = await page.evaluate(() => (window as unknown as { out: Promise<unknown> }).out);
        await page.close();
        return { out, log: [...log] };
    };

    it("preflights as directly", async () => {
        const direct = await run(`${self}/page.html`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/${self.slice(7)}/page.html`);
        expect(direct.log.filter((l) => l.includes(" OPTIONS ")).length).toBeGreaterThan(15);
        expect(proxied.out).toEqual(direct.out);
        // Each case's requests in their order (a preflight before its
        // request); cases running at once (the worker's) may interleave.
        const byCase = (log: string[]): string[] => {
            const m = new Map<string, string[]>();
            for (const l of log) { const c = l.split(" ")[0]!; m.set(c, [...(m.get(c) ?? []), l]); }
            return [...m.keys()].sort().flatMap((k) => m.get(k)!);
        };
        expect(byCase(proxied.log)).toEqual(byCase(direct.log));
    }, 90_000);
});
