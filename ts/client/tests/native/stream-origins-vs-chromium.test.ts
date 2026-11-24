// @vitest-environment node
//
// Streams, in real Chromium, direct and through the real proxy: a message's
// origin is the stream URL's (spec/Messaging.agda streamOrigin; round H/K:
// an EventSource's read the proxy's, a WebSocket's the proxy's wss:), and
// a WebSocketStream connects through the proxy (round K: it was not
// wrapped, and went from the browser straight to the origin, Origin the
// proxy's). The server echoes the Origin its handshake carried; every
// socket the browser opens is listed.
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

describe.skipIf(!wanted)("streams\u2019 origins and WebSocketStream, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/es") { res.writeHead(200, { "content-type": "text/event-stream" }); return res.end("data: x\n\n"); }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><script>
window.out = {};
const es = new EventSource("/es"); es.onmessage = (e) => { out.es = e.origin; es.close(); };
const ws = new WebSocket("ws://" + location.host + "/ws"); ws.onmessage = (e) => { out.ws = e.origin; out.wsOrigin = e.data; ws.close(); };
if (window.WebSocketStream) {
  const st = new WebSocketStream("ws://" + location.host + "/st");
  st.opened.then(async ({ readable }) => { const r = readable.getReader(); out.stream = (await r.read()).value; out.streamUrl = st.url; st.close(); }, (e) => { out.stream = "fail " + e.name; });
} else out.stream = "absent";
</script>`);
        });
        upstream.on("upgrade", (req, sock) => {
            const accept = createHash("sha1").update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
            sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
            const body = Buffer.from(String(req.headers.origin ?? "none"));
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

    const run = async (proxied: boolean): Promise<{ out: Record<string, unknown>; sockets: string[] }> => {
        const url = proxied ? `${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page` : `http://127.0.0.1:${port0}/page`;
        const p = await browser.newPage();
        const sockets: string[] = [];
        p.on("websocket", (w) => sockets.push(w.url()));
        await p.goto(url);
        await p.evaluate(() => new Promise((res) => setTimeout(res, 2000)));
        const out = await p.evaluate(() => (window as unknown as { out: Record<string, unknown> }).out);
        await p.close();
        return { out, sockets };
    };

    it("give a stream's origin and keep every socket on the proxy, as directly", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        const o = `http://127.0.0.1:${port0}`;
        expect(direct.out).toEqual({ es: o, ws: `ws://127.0.0.1:${port0}`, wsOrigin: o, stream: o, streamUrl: `ws://127.0.0.1:${port0}/st` });
        expect(proxied.out).toEqual(direct.out);
        expect(proxied.sockets.length).toBe(2);
        for (const s of proxied.sockets) expect(s.startsWith(proxyOrigin.replace(/^http/, "ws") + "/")).toBe(true);
    }, 60_000);
});
