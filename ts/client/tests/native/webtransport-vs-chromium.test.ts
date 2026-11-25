// @vitest-environment node
//
// WebTransport, in real Chromium, direct and proxied (round J: it connected
// over QUIC straight to the origin). Proxied, the attempt goes to the
// proxy (which carries no HTTP/3) and fails there: `ready` rejects as for
// an unreachable server, and the origin hears nothing.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createSocket, type Socket } from "node:dgram";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void>; on(e: "request", f: (r: { url(): string }) => void): void };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const SCRIPT = `
window.out = null;
const t = new WebTransport("https://127.0.0.1:__UDP__/wt?x=1");
t.ready.then(() => { out = "ready"; }, (e) => { out = e.name; });
`;

describe.skipIf(!wanted)("WebTransport, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";
    let udp: Socket;
    let udpPort = 0;
    let packets = 0;

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        udp = createSocket("udp4");
        udp.on("message", () => { packets++; });
        await new Promise<void>((r) => udp.bind(0, "127.0.0.1", () => r()));
        udpPort = udp.address().port;
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u.startsWith("/rewriter.js")) {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            if (u.startsWith("/a/direct") || u.startsWith("/cyrano/https/site.example/a/page")) {
                const boot = u.startsWith("/a/direct") ? "" : `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js",toolbar:false}).inject();$rewriter.set_location("https://site.example/a/page");</script>`;
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(`<!doctype html><html><head>${boot}</head><body><script>const s = document.createElement("script"); s.text = ${JSON.stringify(SCRIPT.replace("__UDP__", String(udpPort))).replace(/</g, "\\u003c")}; document.body.appendChild(s);</script></body></html>`);
            }
            res.writeHead(404);
            return res.end();
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
        udp?.close();
    });

    const run = async (path: string): Promise<{ out: unknown; asked: string[] }> => {
        const page = await browser.newPage();
        const asked: string[] = [];
        page.on("request", (r) => { const m = /img\.example\/p\.png\?k=(\d)/.exec(r.url()); if (m) asked.push((r.url().startsWith(origin) ? "proxy " : "OUT ") + m[1]); });
        await page.goto(origin + path);
        packets = 0;
        let out: unknown = null;
        for (let i = 0; i < 50 && out === null; i++) {
            await new Promise((res) => setTimeout(res, 200));
            out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        }
        out = { ready: out, packets };
        await page.close();
        return { out, asked: [...new Set(asked)].sort() };
    };

    it("fails at the proxy, never around it", async () => {
        const direct = await run("/a/direct");
        const proxied = await run("/cyrano/https/site.example/a/page");
        expect((direct.out as { ready: unknown }).ready).toBe("WebTransportError");
        expect((direct.out as { packets: number }).packets).toBeGreaterThan(0);
        expect(proxied.out).toEqual({ ready: "WebTransportError", packets: 0 });
    }, 30_000);
});
