// @vitest-environment node
//
// statusText, in real Chromium, direct and through the real proxy (round I:
// an HTTP/1.x origin's reason phrase was lost — the browser talks HTTP/2 to
// the proxy, which has none; over plain HTTP it was the proxy's own). The
// proxy carries the origin's in Crn-H (spec/Carry.agda statusText), which
// fetch and XHR read; it is no header (none lists it).
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

describe.skipIf(!wanted)("statusText, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/nf") { res.writeHead(404, "Nothing Here", { "content-type": "text/plain" }); return res.end("x"); }
            if (u.pathname === "/ok") { res.writeHead(200, "Fine Thanks", { "content-type": "text/plain" }); return res.end("x"); }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><script>
window.out = null;
(async () => {
  const r = await fetch("/nf"); const r2 = await fetch("/ok");
  const names = [...r.headers.keys()].filter((n) => n.startsWith(":") || n === "crn-h");
  const x = new XMLHttpRequest(); x.open("GET", "/nf", false); x.send();
  window.out = { fetch: r.status + " " + r.statusText, ok: r2.statusText, names, xhr: x.status + " " + x.statusText, all: x.getAllResponseHeaders().includes(":status-text") };
})();
</script>`);
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

    const run = async (proxied: boolean): Promise<unknown> => {
        const url = proxied ? `${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page` : `http://127.0.0.1:${port0}/page`;
        const p = await browser.newPage();
        await p.goto(url);
        let out: unknown = null;
        for (let i = 0; i < 25 && out === null; i++) {
            await new Promise((res) => setTimeout(res, 200));
            out = await p.evaluate(() => (window as unknown as { out: unknown }).out);
        }
        await p.close();
        return out;
    };

    it("is the origin's reason phrase, as directly", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        expect(direct).toEqual({ fetch: "404 Nothing Here", ok: "Fine Thanks", names: [], xhr: "404 Nothing Here", all: false });
        expect(proxied).toEqual(direct);
    }, 60_000);
});
