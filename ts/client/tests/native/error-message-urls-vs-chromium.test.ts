// @vitest-environment node
//
// Error messages that name a URL, in real Chromium, direct and through the
// real proxy (round I: a failed import() named the proxified URL —
// "Failed to fetch dynamically imported module: https://proxy/cyrano/
// https!js/…" — and a worker's failed importScripts too). The page reads
// its own URL in them, as directly: the runtime puts the message right
// before the page's handlers see it (url/error-text.ts; R7 wraps import()'s
// result), and unhandledrejection fires only for the import the page left
// uncaught, naming its promise. Each URL is read relative to the page's
// own origin.
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

describe.skipIf(!wanted)("error messages naming a URL, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/w.js") {
                res.writeHead(200, { "content-type": "text/javascript" });
                return res.end(`try { importScripts("/nope.js"); } catch (e) { postMessage(e.name + ": " + e.message.split(self.location.origin).join("ORIGIN")); }`);
            }
            if (u.pathname !== "/page") { res.writeHead(404, { "content-type": "text/plain" }); return res.end("no"); }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><script>
window.out = {};
const rel = (m) => String(m).split(location.origin).join("ORIGIN");
out.unhandled = [];
addEventListener("unhandledrejection", (e) => { out.unhandled.push(rel(e.reason && e.reason.message) + (e.promise === p2 ? " (its promise)" : "")); });
import("/nope.mjs").catch((e) => { out.caught = e.name + ": " + rel(e.message); out.stack = rel(String(e.stack).split("\\n")[0]); });
const p2 = import("/nope2.mjs");
new Worker("/w.js").onmessage = (e) => { out.worker = e.data; };
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
        await p.evaluate(() => new Promise((res) => setTimeout(res, 2000)));
        const out = await p.evaluate(() => (window as unknown as { out: unknown }).out);
        await p.close();
        return out;
    };

    it("name the page's URL, as directly", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        expect(direct).toEqual({
            caught: "TypeError: Failed to fetch dynamically imported module: ORIGIN/nope.mjs",
            stack: "TypeError: Failed to fetch dynamically imported module: ORIGIN/nope.mjs",
            unhandled: ["Failed to fetch dynamically imported module: ORIGIN/nope2.mjs (its promise)"],
            worker: "NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at 'ORIGIN/nope.js' failed to load.",
        });
        expect(proxied).toEqual(direct);
    }, 60_000);
});
