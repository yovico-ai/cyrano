// @vitest-environment node
//
// A frame on its way to a proxied URL, in real Chromium, direct and through
// the real proxy (spec/Frames.agda frameRuntime pendingFrame). Until that
// navigation commits the frame holds its initial about:blank, and page code
// writes into it: Ruffle (freeasteroids.org) put a <script src> into every
// frame's document — it loaded from the origin; rewritten code written there
// threw `$rewriter is not defined` (nordstrom.com, my.adp.com). Then the
// frame's own document takes the window over (the realm is kept) and must
// read what is its own: its URL, its referrer, its cookies, its markup as
// written.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const binary = process.env.CYRANO_BINARY ?? resolve(root, "go/assets/cyrano");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(binary);

type CDP = { send(m: string, p?: object): Promise<unknown>; on(e: string, f: (e: { request: { url: string } }) => void): void };
type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; waitForFunction(f: () => unknown, a?: unknown, o?: object): Promise<unknown>; on(e: string, f: (x: Error) => void): void };
type Context = { newPage(): Promise<Page>; newCDPSession(p: Page): Promise<CDP>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };

const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

type Seen = { inline: string; slow: { url: string; ref: string; cookie: string; href: string; outer: string } };

describe.skipIf(!wanted)("a frame written into before its proxied document arrives, in Chromium", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;
    let hits: string[] = [];

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/s.js") {
                hits.push(u.searchParams.get("k") ?? "?");
                res.writeHead(200, { "content-type": "text/javascript" });
                return res.end("parent.__loaded = (parent.__loaded || 0) + 1;");
            }
            if (u.pathname === "/slow") {
                // The frame's own document, late: its own cookie, its own markup.
                setTimeout(() => {
                    res.writeHead(200, { "content-type": "text/html", "set-cookie": "own=slow; Path=/" });
                    res.end(`<!doctype html><a id=a href="/x?y">x</a><script>
                        const a = document.getElementById("a");
                        parent.__slow = { url: location.href, ref: document.referrer, cookie: document.cookie, href: a.getAttribute("href"), outer: a.outerHTML };
                    </script>`);
                }, 1500);
                return;
            }
            const self = `http://127.0.0.1:${port0}`;
            // Its frame's referrer is the page's origin alone: the frame's own
            // config says so, the browser (told unsafe-url) would not.
            res.writeHead(200, { "content-type": "text/html", "referrer-policy": "origin" });
            return res.end(`<!doctype html><body><script>
                const f = document.createElement("iframe");
                f.src = "/slow";
                document.body.appendChild(f);
                const d = f.contentDocument;
                // As Ruffle: a script element of the frame's document, its src set natively there.
                const s = d.createElement("script");
                s.setAttribute("src", ${JSON.stringify(self)} + "/s.js?k=attr");
                d.head.appendChild(s);
                // Code written into it, which the rules touch (location).
                const t = d.createElement("script");
                t.textContent = "parent.__inline = String(location.href)";
                d.head.appendChild(t);
            </script>`);
        });
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

    const run = async (proxied: boolean): Promise<{ seen: Seen; errors: string[]; offProxy: string[]; hits: string[] }> => {
        const url = proxied ? `${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page` : `http://127.0.0.1:${port0}/page`;
        hits = [];
        const ctx = await browser.newContext();
        const p = await ctx.newPage();
        const errors: string[] = [];
        p.on("pageerror", (e) => errors.push(String(e.message)));
        const offProxy: string[] = [];
        if (proxied) {
            const cdp = await ctx.newCDPSession(p);
            await cdp.send("Network.enable");
            cdp.on("Network.requestWillBeSent", (e) => { if (!e.request.url.startsWith(proxyOrigin) && !e.request.url.startsWith("data:")) offProxy.push(e.request.url); });
        }
        await p.goto(url);
        await p.waitForFunction(() => (window as unknown as { __slow?: unknown }).__slow, undefined, { timeout: 10_000 });
        const seen = await p.evaluate(() => ({ inline: (window as unknown as { __inline: string }).__inline, slow: (window as unknown as { __slow: Seen["slow"] }).__slow }));
        await ctx.close();
        return { seen, errors, offProxy, hits: [...hits] };
    };

    it("what is written goes through the proxy; the frame's document then reads its own", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        // Direct: the script loads into the initial about:blank, the inline code reads it.
        expect(direct.hits).toEqual(["attr"]);
        expect(direct.seen.inline).toBe("about:blank");
        expect(direct.errors).toEqual([]);
        // Through the proxy: the same, nothing from the browser to the origin, no error.
        expect(proxied.offProxy).toEqual([]);
        expect(proxied.errors).toEqual([]);
        expect(proxied.hits).toEqual(direct.hits);
        expect(proxied.seen.inline).toBe(direct.seen.inline);
        // The frame's document, which took the window over, reads its own.
        expect(proxied.seen.slow.url).toBe(`http://127.0.0.1:${port0}/slow`);
        expect(direct.seen.slow.ref).toBe(`http://127.0.0.1:${port0}/`);
        expect(proxied.seen.slow).toEqual(direct.seen.slow);
    }, 60_000);
});
