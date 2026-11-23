// @vitest-environment node
//
// Media Session artwork, in real Chromium, direct and proxied (visitoslo.com,
// 2026-11-23: YouTube's player set navigator.mediaSession.metadata, and the
// browser fetched the artwork from its origin). Once audible media has
// played, the browser fetches the artwork itself: through the proxy, as
// direct reaches the origin; and the page reads its URLs back as written.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

// A 14 s tone (8 kHz, 8-bit mono WAV): audible media for the media session.
const tone = (() => {
    const n = 8000 * 14, b = Buffer.alloc(44 + n);
    b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
    for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(100 * Math.sin((2 * Math.PI * 440 * i) / 8000));
    return b;
})();
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const SCRIPT = `
const a = new Audio("/tone.wav"); a.play();
setTimeout(() => {
  navigator.mediaSession.metadata = new MediaMetadata({ title: "t", artwork: [{ src: "http://cdn.example/art.png", sizes: "96x96", type: "image/png" }] });
  const m = navigator.mediaSession.metadata;
  window.out = { src: m.artwork[0].src, same: m.artwork === m.artwork, frozen: Object.isFrozen(m.artwork) && Object.isFrozen(m.artwork[0]), sizes: m.artwork[0].sizes };
}, 12000);
`;

describe.skipIf(!wanted)("Media Session artwork, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";
    let seen: string[] = [];

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u.startsWith("/rewriter.js")) {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            if (u === "/direct" || u.startsWith("/cyrano/https/site.example/page")) {
                const boot = u === "/direct" ? "" : `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/page");</script>`;
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(`<!doctype html><html><head>${boot}</head><body><script>${SCRIPT}</script></body></html>`);
            }
            if (/tone\.wav$/.test(u)) {
                res.writeHead(200, { "content-type": "audio/wav" });
                return res.end(tone);
            }
            if (/art\.png/.test(u)) {
                seen.push(req.headers.host?.startsWith("cdn.example") ? "DIRECT" : "proxied");
                res.writeHead(200, { "content-type": "image/png" });
                return res.end(PNG);
            }
            res.writeHead(404);
            return res.end();
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch({ args: [`--host-resolver-rules=MAP cdn.example 127.0.0.1:${new URL(origin).port}`, "--autoplay-policy=no-user-gesture-required"] });
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const run = async (path: string): Promise<{ out: unknown; seen: string[] }> => {
        seen = [];
        const page = await browser.newPage();
        await page.goto(origin + path);
        await new Promise((res) => setTimeout(res, 15000));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return { out, seen: [...new Set(seen)] };
    };

    it("the artwork loads through the proxy, as direct, and reads back as written", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/page");
        expect(direct.out).toEqual({ src: "http://cdn.example/art.png", same: false, frozen: true, sizes: "96x96" });
        expect(proxied.out).toEqual(direct.out);
        expect(direct.seen).toEqual(["DIRECT"]);
        expect(proxied.seen).toEqual(["proxied"]);
    }, 60_000);
});
