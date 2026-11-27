// @vitest-environment node
//
// A frame on its way to a proxied URL is given its creator's runtime, and
// its document adopts it (spec/Frames.agda frameRuntime); a frame that
// document then makes and writes into must get the same copy of the
// runtime. Given the copy its own bootstrap loaded, two copies wrapped its
// document.write and the outer one rewrote the markup against the wrong
// base: Flashtalking's richload on ginifab.com (a <base href> then a
// relative stylesheet, written into a frame in a shadow root) took its
// stylesheet from the shell's folder (a 404), and its copy-fitting loop never
// ended (the page hung).
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const binary = process.env.CYRANO_BINARY ?? resolve(root, "go/assets/cyrano");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(binary);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: string, f: (x: Error) => void): void };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };

const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

describe.skipIf(!wanted)("a frame made by a frame that adopted its creator's runtime, in Chromium", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;
    let hits: string[] = [];

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u === "/api.js") {
                res.writeHead(200, { "content-type": "text/javascript" });
                return res.end(`
                    const host = document.createElement("div"); document.body.appendChild(host);
                    const root = host.attachShadow({ mode: "open" });
                    const f = document.createElement("iframe"); root.appendChild(f);
                    const a = document.createElement("a"); a.href = "/rich/index.html";
                    f.contentDocument.write('<head><base href="' + a.href + '"></head><link rel="stylesheet" href="styles.css"><script src="index.js"><\\/script><div id=h>x</div>');
                    f.contentDocument.close();`);
            }
            if (/\.(css|js)$/.test(u)) {
                hits.push(u);
                res.writeHead(200, { "content-type": u.endsWith(".css") ? "text/css" : "text/javascript" });
                return res.end(u.endsWith(".css") ? "#h{color:red}" : "1");
            }
            if (u.startsWith("/shell")) {
                // Late: the frame holds its initial about:blank (and the creator's runtime) a while.
                setTimeout(() => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<!doctype html><body><script src="/api.js"></script>`); }, 500);
                return;
            }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><body><script>const f = document.createElement("iframe"); f.src = "/shell/index.html"; document.body.appendChild(f);</script>`);
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

    const run = async (proxied: boolean): Promise<string[]> => {
        const url = proxied ? `${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page` : `http://127.0.0.1:${port0}/page`;
        hits = [];
        const ctx = await browser.newContext();
        const p = await ctx.newPage();
        await p.goto(url);
        await p.evaluate(() => new Promise((r) => setTimeout(r, 2000)));
        await ctx.close();
        return [...hits].sort();
    };

    it("what is written loads from the written base", async () => {
        const direct = await run(false);
        expect(direct).toEqual(["/rich/index.js", "/rich/styles.css"]);
        expect(await run(true)).toEqual(direct);
    }, 60_000);
});
