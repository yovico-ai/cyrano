// @vitest-environment node
//
// postMessage's options form, in real Chromium, direct and through the real
// proxy (round I: postMessage(msg, {targetOrigin}) was never delivered —
// the dictionary went to the browser as given, its origin the page's, the
// recipient's the proxy's). Its targetOrigin ("/" by default) is judged as
// the string form's; a mismatch is dropped as directly.
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

describe.skipIf(!wanted)("postMessage with options, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            res.writeHead(200, { "content-type": "text/html" });
            const other = `http://localhost:${port0}`, mine = `http://127.0.0.1:${port0}`;
            if (u.pathname === "/top") return res.end(`<iframe id=s src="/child"></iframe><iframe id=x src="${other}/child"></iframe><script>
                window.got = [];
                addEventListener("message", (e) => { if (typeof e.data === "string" && e.data.startsWith("echo ")) window.got.push(e.data.slice(5)); else if (e.data === "self-opts" || e.data === "self-default") window.got.push(e.data); });
                addEventListener("load", () => setTimeout(() => {
                    const s = document.getElementById("s").contentWindow, x = document.getElementById("x").contentWindow;
                    s.postMessage("s-opts", { targetOrigin: "${mine}" });
                    s.postMessage("s-wrong", { targetOrigin: "${other}" });
                    s.postMessage("s-default", {});
                    x.postMessage("x-opts", { targetOrigin: "${other}" });
                    x.postMessage("x-default", {});
                    x.postMessage("x-string", "${other}");
                    window.postMessage("self-opts", { targetOrigin: location.origin });
                    window.postMessage("self-default");
                }, 200));
            </script>`);
            if (u.pathname === "/child") return res.end(`<script>addEventListener("message", (e) => { if (e.source === parent) parent.postMessage("echo " + e.data, "*"); });</script>`);
            return res.end("");
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

    const run = async (url: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(url);
        await new Promise((r) => setTimeout(r, 1200));
        const got = await page.evaluate(() => (window as unknown as { got: string[] }).got.slice().sort());
        await page.close();
        return got;
    };

    it("is delivered where it would be, as directly", async () => {
        const direct = await run(`http://127.0.0.1:${port0}/top`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/top`);
        expect(direct).toEqual(["s-default", "s-opts", "self-default", "self-opts", "x-opts", "x-string"]);
        expect(proxied).toEqual(direct);
    }, 60_000);
});
