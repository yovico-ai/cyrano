// @vitest-environment node
//
// A document the origin sends in parts, in real Chromium, direct and
// through the real proxy (Go server/stream.go, htmlrewrite/streaming.go).
// The proxy read and rewrote the whole document before its first byte:
// the browser fetched no stylesheet and painted nothing until the
// origin's last byte (bbc.com's first byte 1.2 s after direct's). The
// origin here sends its head — a stylesheet, text — then works 1.5 s on
// the body: the stylesheet is asked for, and the head's text painted,
// before the body comes, as directly. The document's sizes read as the
// origin sent them (crnb by token, the sizes in the session's next
// response: spec/Carry.agda crnbRef, sizesCookie).
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const binary = process.env.CYRANO_BINARY ?? resolve(root, "go/assets/cyrano");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(binary);

type Page = { goto(u: string, o?: object): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; waitForFunction(f: () => unknown, a?: unknown, o?: object): Promise<unknown> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };

const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

const HEAD = `<!doctype html><html><head><link rel=stylesheet href="/s.css"><title>t</title></head><body><p id=early>early</p>`;
// (a request after the body: its response carries the sizes, spec Carry.sizesCookie)
const BODY = `<p id=late>late</p>${"<p>filler</p>".repeat(200)}<img src="/after.png"></body></html>`;
const WORK = 1500;

describe.skipIf(!wanted)("a document sent in parts, in Chromium", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;
    let t0 = 0;
    let cssAt = -1;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/after.png") {
                res.writeHead(204);
                return res.end();
            }
            if (u.pathname === "/s.css") {
                cssAt = Date.now() - t0;
                res.writeHead(200, { "content-type": "text/css" });
                return res.end("p{color:red}");
            }
            const gz = u.searchParams.has("gz");
            t0 = Date.now();
            cssAt = -1;
            res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...(gz ? { "content-encoding": "gzip" } : {}) });
            if (gz) {
                // A gzip stream flushed at the head (as a compressing SSR server).
                const zlib = require("node:zlib") as typeof import("node:zlib");
                const z = zlib.createGzip();
                z.pipe(res);
                z.write(HEAD);
                z.flush();
                setTimeout(() => { z.end(BODY); }, WORK);
                return undefined;
            }
            res.write(HEAD);
            setTimeout(() => res.end(BODY), WORK);
            return undefined;
        });
        void gzipSync;
        await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
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

    type Seen = { cssAt: number; earlyAt: number; sizes: { encoded: number; decoded: number } };
    const run = async (proxied: boolean, gz: boolean): Promise<Seen> => {
        const path = `/page${gz ? "?gz" : ""}`;
        const url = proxied ? `${proxyOrigin}/cyrano/http/127.0.0.1:${port0}${path}` : `http://127.0.0.1:${port0}${path}`;
        const ctx = await browser.newContext();
        const p = await ctx.newPage();
        const go = p.goto(url, { waitUntil: "commit" });
        // The head's text is in the document while the origin still works on the body.
        await p.waitForFunction(() => document.getElementById("early") !== null, undefined, { timeout: 10_000 });
        const earlyAt = Date.now() - t0;
        await go;
        await p.waitForFunction(() => document.readyState === "complete", undefined, { timeout: 15_000 });
        await new Promise((r) => setTimeout(r, 500));
        const sizes = await p.evaluate(() => {
            const n = performance.getEntriesByType("navigation")[0] as PerformanceResourceTiming;
            return { encoded: n.encodedBodySize, decoded: n.decodedBodySize };
        });
        const seen = { cssAt, earlyAt, sizes };
        await ctx.close();
        return seen;
    };

    for (const gz of [false, true]) {
        it(`the head is parsed and its stylesheet asked for before the body comes${gz ? " (gzip)" : ""}`, async () => {
            const direct = await run(false, gz);
            const proxied = await run(true, gz);
            expect(direct.cssAt).toBeGreaterThanOrEqual(0);
            expect(direct.cssAt).toBeLessThan(WORK);
            expect(direct.earlyAt).toBeLessThan(WORK);
            expect(proxied.cssAt, "stylesheet asked for after the body came").toBeGreaterThanOrEqual(0);
            expect(proxied.cssAt, "stylesheet asked for after the body came").toBeLessThan(WORK);
            expect(proxied.earlyAt, "the head's text parsed after the body came").toBeLessThan(WORK);
            expect(proxied.sizes).toEqual(direct.sizes);
        }, 60_000);
    }
});
