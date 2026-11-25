// @vitest-environment node
//
// A worker script of another origin, in real Chromium, direct and through
// the real proxy (round I: through the proxy every URL is same-origin, and
// it ran). The native's SecurityError, word for word; same-origin and data:
// workers run as before.
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

describe.skipIf(!wanted)("a worker script of another origin, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname.endsWith(".js")) { res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" }); return res.end("postMessage('ran');"); }
            const b = `http://localhost:${port0}`;
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><script>
window.out = {};
const rel = (s) => String(s).split(location.origin).join("O").split("${b}").join("X");
const t = (k, f) => { try { const w = f(); out[k] = "made"; if (w.onmessage !== undefined) w.onmessage = (e) => { out[k] = "ran"; }; if (w.port) { w.port.onmessage = () => { out[k] = "ran"; }; } } catch (e) { out[k] = e.name + ": " + rel(e.message); } };
t("cross", () => new Worker("${b}/w.js"));
t("crossModule", () => new Worker("${b}/m.js", { type: "module" }));
t("shared", () => new SharedWorker("${b}/s.js"));
t("same", () => new Worker("/w.js"));
t("data", () => new Worker("data:text/javascript,postMessage(1)"));
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
        await new Promise((res) => setTimeout(res, 1500));
        const out = await p.evaluate(() => (window as unknown as { out: unknown }).out);
        await p.close();
        return out;
    };

    it("is refused as directly", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        const sec = (n: string, f: string) => `SecurityError: Failed to construct '${n}': Script at 'X/${f}' cannot be accessed from origin 'O'.`;
        expect(direct).toEqual({ cross: sec("Worker", "w.js"), crossModule: sec("Worker", "m.js"), shared: sec("SharedWorker", "s.js"), same: "ran", data: "ran" });
        expect(proxied).toEqual(direct);
    }, 60_000);
});
