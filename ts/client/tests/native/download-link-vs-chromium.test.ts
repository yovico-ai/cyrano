// @vitest-environment node
//
// <a download> to another origin, in real Chromium, direct and through the
// real proxy (round I: proxied it downloaded; Chromium ignores download for
// a URL that is not same-origin and the link navigates). Clicked, a
// cross-origin one navigates; a same-origin one downloads.
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

describe.skipIf(!wanted)("cross-origin download links, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/f.txt") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("file"); }
            res.writeHead(200, { "content-type": "text/html" });
            if (u.pathname === "/page") return res.end(`<a id=x href="http://localhost:${port0}/landed" download="f.txt">x</a><a id=s href="/f.txt" download="s.txt">s</a>
                `);
            return res.end("<title>landed</title>");
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

    type P = { goto(u: string): Promise<unknown>; click(s: string): Promise<void>; evaluate<T>(f: () => T): Promise<T>; waitForTimeout(ms: number): Promise<void>; url(): string; close(): Promise<void>; on(e: string, f: (d: { suggestedFilename(): string }) => void): void };
    const run = async (url: string): Promise<{ cross: string; downloads: string[] }> => {
        const ctx = await (browser as unknown as { newContext(o: object): Promise<{ newPage(): Promise<P>; close(): Promise<void> }> }).newContext({ acceptDownloads: true });
        const page = await ctx.newPage();
        const downloads: string[] = [];
        page.on("download", (d) => downloads.push(d.suggestedFilename()));
        await page.goto(url);
        await page.click("#s");
        await page.waitForTimeout(800);
        await page.click("#x");
        await page.waitForTimeout(1200);
        const cross = new URL(page.url()).pathname;
        await ctx.close();
        return { cross, downloads };
    };

    it("navigates there, as directly", async () => {
        const direct = await run(`http://127.0.0.1:${port0}/page`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page`);
        expect(direct).toEqual({ cross: "/landed", downloads: ["s.txt"] });
        expect(proxied.downloads).toEqual(direct.downloads);
        expect(proxied.cross).toMatch(/\/landed$/);
    }, 60_000);
});
