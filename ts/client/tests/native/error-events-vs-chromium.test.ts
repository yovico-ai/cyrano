// @vitest-environment node
//
// Window error events, in real Chromium, direct and through the real proxy
// (round H: `filename` and onerror's `source` named the proxified URL, and
// a cross-origin script's errors reached the page whole — every script is
// fetched CORS same-origin from the proxy, so the browser never mutes one).
// Now as directly: a classic script of another origin fetched without CORS
// is muted ("Script error.", "", 0, 0, null), for listeners and onerror
// alike; the rest name the page's URL (spec/ErrorEvents.agda).
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
type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };



const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

describe.skipIf(!wanted)("window error events, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            const k = u.searchParams.get("k");
            if (u.pathname === "/thr.js") {
                res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" });
                return res.end(`setTimeout(function () { throw new Error("detail ${k}"); }, 10);`);
            }
            const b = `http://localhost:${port0}`;
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><script>
window.out = [];
const rel = (s) => String(s).split(location.origin).join("O").split("${b}").join("X");
addEventListener("error", (e) => { out.push("L " + rel(e.message) + " | " + rel(e.filename) + " | " + e.lineno + ":" + e.colno + " | " + (e.error ? "err" : "noerr")); });
const h = function (m, s, l, c, err) { out.push("H " + rel(m) + " | " + rel(s) + " | " + l + ":" + c + " | " + (err ? "err" : "noerr")); };
window.onerror = h; out.push("identity " + (window.onerror === h) + " " + (document.body === null || document.body.onerror === h));
</script><script src="/thr.js?k=same"></script><script src="${b}/thr.js?k=cross"></script>
<script crossorigin src="${b}/thr.js?k=cors"></script><script type=module src="${b}/thr.js?k=module"></script>`);
        });
        await new Promise<void>((r) => upstream.listen(0, "0.0.0.0", () => r()));
        port0 = (upstream.address() as { port: number }).port;
        self = `http://127.0.0.1:${port0}`;
        void self;
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

    const run = async (proxied: boolean): Promise<string[]> => {
        const url = proxied ? `${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page` : `http://127.0.0.1:${port0}/page`;
        const p = await browser.newPage();
        await p.goto(url);
        await p.evaluate(() => new Promise((res) => setTimeout(res, 1500)));
        const out = await p.evaluate(() => (window as unknown as { out: string[] }).out);
        await p.close();
        return [...out].sort();
    };

    it("are muted and name the page's URL, as directly", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        expect(direct).toEqual([
            "H Script error. |  | 0:0 | noerr", "H Uncaught Error: detail cors | X/thr.js?k=cors | 1:32 | err",
            "H Uncaught Error: detail module | X/thr.js?k=module | 1:32 | err", "H Uncaught Error: detail same | O/thr.js?k=same | 1:32 | err",
            "L Script error. |  | 0:0 | noerr", "L Uncaught Error: detail cors | X/thr.js?k=cors | 1:32 | err",
            "L Uncaught Error: detail module | X/thr.js?k=module | 1:32 | err", "L Uncaught Error: detail same | O/thr.js?k=same | 1:32 | err",
            "identity true true",
        ]);
        expect(proxied).toEqual(direct);
    }, 60_000);
});
