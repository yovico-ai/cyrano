// @vitest-environment node
//
// Legacy-encoded documents, in real Chromium, direct and through the real
// proxy (round I: in a windows-1251 / Shift_JIS page the server turned a
// URL attribute's non-ASCII query into U+FFFD, the client encoded a query
// as UTF-8; round K: a reference to a character the encoding lacks came
// back as mojibake). The bytes the origin receives for a static image, a
// script-set image and an XHR, and what the page reads, as directly.
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

describe.skipIf(!wanted)("legacy-encoded documents, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let seen: string[] = [];

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/i") { seen.push((req.url ?? "").replace(/^\/i\?/, "")); res.writeHead(200, { "content-type": "image/gif" }); return res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")); }
            const cs = u.pathname === "/sjis" ? "shift_jis" : "windows-1251";
            // The word in the page's encoding: поиск in windows-1251, 表 in Shift_JIS.
            const word = cs === "shift_jis" ? Buffer.from([0x95, 0x5c]) : Buffer.from([0xef, 0xee, 0xe8, 0xf1, 0xea]);
            const page = `<!doctype html><meta charset="${cs}"><title>t</title><img src="/i?s=@W@"><a id=a href="/p?q=@W@" title="&#252;">x</a>
                <script>
                    window.out = new Promise((done) => addEventListener("load", () => {
                        const i = new Image(); i.src = "/i?d=" + document.getElementById("w").textContent;
                        const x = new XMLHttpRequest(); x.open("GET", "/i?x=" + document.getElementById("w").textContent); x.send();
                        const a = document.getElementById("a");
                        setTimeout(() => done({ get: a.getAttribute("href"), href: new URL(a.href).pathname + new URL(a.href).search, title: a.title }), 800);
                    }));
                </script><b id=w>@W@</b>`;
            res.writeHead(200, { "content-type": "text/html" });
            const parts = page.split("@W@").map((x) => Buffer.from(x, "latin1"));
            return res.end(Buffer.concat(parts.flatMap((x, k) => (k ? [word, x] : [x]))));
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

    const run = async (url: string): Promise<{ out: unknown; seen: string[] }> => {
        seen = [];
        const page = await browser.newPage();
        await page.goto(url);
        const out = await page.evaluate(() => (window as unknown as { out: Promise<unknown> }).out);
        await page.close();
        return { out, seen: [...new Set(seen)].sort() };
    };

    it("sends and reads what direct does", async () => {
        for (const path of ["/cp1251", "/sjis"]) {
            const direct = await run(`${self}${path}`);
            const proxied = await run(`${proxyOrigin}/cyrano/http/${self.slice(7)}${path}`);
            expect(direct.seen.length, path).toBe(3);
            expect(proxied.seen, path).toEqual(direct.seen);
            expect(proxied.out, path).toEqual(direct.out);
        }
    }, 60_000);
});
