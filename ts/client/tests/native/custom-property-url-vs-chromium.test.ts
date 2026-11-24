// @vitest-environment node
//
// A custom property's url() read back by the page, in real Chromium, direct
// and through the real proxy (lichess.org, round I: its pieces are
// --white-king:url(/assets/…svg), its script takes the URL out of url(…);
// proxied the value read url("https://…") and the quotes made it a broken
// relative URL — 12 images 404). A custom property's value is its tokens
// as written: the rewriters keep each URL's form where they can
// (spec/Css.agda: a url token unquoted, a string in its own quote).
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

describe.skipIf(!wanted)("a custom property\u2019s url(), in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/page.html") {
                res.writeHead(200, { "content-type": "text/html" });
                return res.end(`<!doctype html><style>:root{---a:url(/i.svg?p=1);---b:url('/i.svg?p=2')}</style><script>
                    window.out = new Promise((done) => addEventListener("load", async () => {
                        const cs = getComputedStyle(document.documentElement), o = {};
                        for (const k of ["---a", "---b"]) {
                            const v = cs.getPropertyValue(k).trim();
                            const src = v.slice(4, -1).replace(/^['"]|['"]$/g, "");
                            const img = new Image();
                            o[k] = await new Promise((r) => { img.onload = () => r("load " + v.slice(0, 4) + v.slice(4, 5)); img.onerror = () => r("error"); img.src = src; });
                        }
                        done(o);
                    }));
                </script>`);
            }
            if (u.pathname === "/i.svg") {
                res.writeHead(200, { "content-type": "image/svg+xml" });
                return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
            }
            res.writeHead(404);
            return res.end();
        });
        await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
        self = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
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

    const run = async (url: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(url);
        const out = await page.evaluate(() => (window as unknown as { out: Promise<unknown> }).out);
        await page.close();
        return out;
    };

    it("loads what the page takes out of it, as directly", async () => {
        const direct = await run(`${self}/page.html`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/${self.slice(7)}/page.html`);
        expect(direct).toEqual({ "---a": "load url(/", "---b": "load url('" });
        expect(proxied).toEqual({ "---a": "load url(h", "---b": "load url('" });
    }, 60_000);
});
