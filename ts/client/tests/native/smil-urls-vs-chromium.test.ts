// @vitest-environment node
//
// SVG animation (SMIL) of URL attributes, in real Chromium, through the real
// proxy (round H probe: the animated values went to their origin, both
// runtimes). An <animate> / <set> takes the kind of the attribute its
// attributeName names (spec/Attrs.agda attrKindIn): markup the server
// rewrites, values the page sets before or after attributeName — every
// image asked of the proxy, as direct asks the origin, and read back as
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

type Req = { url(): string };
type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };



const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

describe.skipIf(!wanted)("SMIL values of URL attributes, in Chromium, through the proxy", () => {
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
                return res.end(`<!doctype html><svg width=200 height=200>
                    <image href="/i.svg?k=0" width=10 height=10><animate attributeName="href" values="/i.svg?k=0; ${self}/i.svg?k=1" dur="0.3s" repeatCount="indefinite"/></image>
                    <image id=b href="/i.svg?k=0" width=10 height=10></image>
                    <image id=c href="/i.svg?k=0" width=10 height=10></image>
                    <rect width=10 height=10><set attributeName="clip-path" to="url(${self}/i.svg?k=4#c)"/></rect>
                    </svg><script>
                    const NS = "http://www.w3.org/2000/svg";
                    const s1 = document.createElementNS(NS, "set"); s1.setAttribute("attributeName", "href"); s1.setAttribute("to", "${self}/i.svg?k=2"); document.getElementById("b").append(s1);
                    const s2 = document.createElementNS(NS, "set"); s2.setAttribute("to", "${self}/i.svg?k=3"); s2.setAttribute("attributeName", "href"); document.getElementById("c").append(s2);
                    window.out = { to: s2.getAttribute("to"), values: document.querySelector("animate").getAttribute("values") };
                    </script>`);
            }
            res.writeHead(200, { "content-type": "image/svg+xml" });
            return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><clipPath id="c"><rect width="5" height="5"/></clipPath></svg>');
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

    const run = async (url: string, proxied: boolean): Promise<{ out: unknown; asked: string[] }> => {
        const page = await browser.newPage();
        const asked = new Set<string>();
        (page as unknown as { on(e: string, f: (r: { url(): string }) => void): void }).on("request", (r) => {
            const m = /i\.svg\?k=([1-4])/.exec(r.url());
            if (m) asked.add((r.url().startsWith(proxied ? proxyOrigin : self) ? "ok " : "OUT ") + m[1]);
        });
        await page.goto(url);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 1500)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return { out, asked: [...asked].sort() };
    };

    it("asks the proxy for every animated URL, as direct asks the origin", async () => {
        const direct = await run(`${self}/page.html`, false);
        const proxied = await run(`${proxyOrigin}/cyrano/http/${self.slice(7)}/page.html`, true);
        expect(direct.asked).toEqual(["ok 1", "ok 2", "ok 3", "ok 4"]);
        expect(proxied.asked).toEqual(direct.asked);
        expect(proxied.out).toEqual(direct.out);
    }, 60_000);
});
