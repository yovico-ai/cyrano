// @vitest-environment node
//
// Cookies and the WebSocket handshake, in real Chromium, direct and
// through the real proxy (round K: a cookie a script wrote just before
// `new WebSocket` was missing from the handshake — it rode the next HTTP
// request only; the cookies a handshake response set were dropped). Now
// as directly: the handshake carries the script's write, and the 101's
// Set-Cookie reach the jar and the page.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const binary = process.env.CYRANO_BINARY ?? resolve(root, "go/assets/cyrano");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(binary);

type Req = { url(): string };
type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: "websocket", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };



const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

describe.skipIf(!wanted)("cookies and the WebSocket handshake, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    let got: Record<string, string> = {};
    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/ck") { got.fetch = String(req.headers.cookie ?? ""); res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><script>
window.out = {};
document.cookie = "wsck=1; path=/";
const ws = new WebSocket("ws://" + location.host + "/ws");
ws.onmessage = (e) => { out.handshake = e.data; out.after = document.cookie.split("; ").sort().join("; "); ws.close(); fetch("/ck").then(() => { out.done = true; }); };
</script>`);
        });
        upstream.on("upgrade", (req, sock) => {
            const accept = createHash("sha1").update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
            sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: wsset=1; Path=/\r\nSet-Cookie: wshttp=1; HttpOnly; Path=/\r\n\r\n`);
            const body = Buffer.from(String(req.headers.cookie ?? ""));
            sock.write(Buffer.concat([Buffer.from([0x81, body.length]), body]));
            sock.on("error", () => undefined);
            setTimeout(() => sock.destroy(), 1500);
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
        got = {};
        const ctx = await (browser as unknown as { newContext(): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }> }).newContext();
        const p = await ctx.newPage();
        await p.goto(url);
        await p.evaluate(() => new Promise((res) => setTimeout(res, 2000)));
        const out = await p.evaluate(() => (window as unknown as { out: unknown }).out);
        await ctx.close();
        return { out, fetch: got.fetch };
    };

    it("carry and take cookies as directly", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        expect(direct).toEqual({ out: { handshake: "wsck=1", after: "wsck=1; wsset=1", done: true }, fetch: "wsck=1; wsset=1; wshttp=1" });
        expect(proxied).toEqual(direct);
    }, 60_000);
});
