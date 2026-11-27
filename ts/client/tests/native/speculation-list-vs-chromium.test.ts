// @vitest-environment node
//
// A speculation rule set a script writes, in real Chromium, direct and
// through the real proxy (spec/Speculation.agda rewriteRuleSet;
// immi-usa.com's "easyopt-speculation-live": a list rule of the URLs its
// links' hrefs read — the page's own — had the browser prefetch them from
// the origin). The list's URLs go through the proxy; the rule set reads
// back as written.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const binary = process.env.CYRANO_BINARY ?? resolve(root, "go/assets/cyrano");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(binary);

type CDP = { send(m: string, p?: object): Promise<unknown>; on(e: string, f: (e: { type?: string; request: { url: string } }) => void): void };
type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; newCDPSession(p: Page): Promise<CDP>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };

const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

describe.skipIf(!wanted)("a list rule a script writes, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;
    let hits: string[] = [];

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/target") {
                if (req.headers["sec-purpose"]) hits.push(u.searchParams.get("k") ?? "?");
                res.writeHead(200, { "content-type": "text/html" });
                return res.end("<p>target");
            }
            const self = `http://127.0.0.1:${port0}`;
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><a id=a href="/target?k=abs">a</a><script>
                const s = document.createElement("script");
                s.type = "speculationrules";
                s.textContent = JSON.stringify({ prefetch: [{ source: "list", urls: [document.getElementById("a").href, "/target?k=rel"], eagerness: "immediate" }] });
                document.head.appendChild(s);
                window.__read = s.textContent;
                window.__self = ${JSON.stringify(self)};
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

    const run = async (proxied: boolean): Promise<{ prefetched: string[]; offProxy: string[]; read: string; self: string; hits: string[] }> => {
        const url = proxied ? `${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page` : `http://127.0.0.1:${port0}/page`;
        hits = [];
        const ctx = await browser.newContext();
        const p = await ctx.newPage();
        const cdp = await ctx.newCDPSession(p);
        await cdp.send("Network.enable");
        const prefetched: string[] = [];
        cdp.on("Network.requestWillBeSent", (e) => { if (e.type === "Prefetch") prefetched.push(e.request.url); });
        await p.goto(url);
        await p.evaluate(() => new Promise((res) => setTimeout(res, 2000)));
        const read = await p.evaluate(() => (window as unknown as { __read: string }).__read);
        const self = await p.evaluate(() => (window as unknown as { __self: string }).__self);
        await ctx.close();
        return { prefetched, offProxy: prefetched.filter((u) => !u.startsWith(proxyOrigin)), read, self, hits: [...hits].sort() };
    };

    it("prefetches the list's URLs through the proxy; the rule set reads back as written", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        // Direct, Chromium prefetches both (the link's href is the page's own URL).
        expect(direct.hits).toEqual(["abs", "rel"]);
        expect(direct.read).toContain(`"${direct.self}/target?k=abs"`);
        // Through the proxy: nothing from the browser straight to the origin,
        // both still prefetched (through the proxy), the text as the page wrote it.
        expect(proxied.offProxy).toEqual([]);
        expect(proxied.hits).toEqual(direct.hits);
        expect(proxied.read).toBe(direct.read);
    }, 60_000);
});
