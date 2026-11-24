// @vitest-environment node
//
// The cross-origin resource policy check, in real Chromium, direct and
// through the real proxy (round K: neither a site's CORP nor an embedder's
// COEP require-corp was enforced — every subresource is same-origin to the
// browser through the proxy). The proxy judges a no-cors response as the
// browser would have (spec/Corp.agda): what loads, as directly.
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

describe.skipIf(!wanted)("CORP and COEP, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let upPort = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/i.gif") {
                const corp = u.searchParams.get("corp");
                res.writeHead(200, { "content-type": "image/gif", ...(corp ? { "cross-origin-resource-policy": corp } : {}) });
                return res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
            }
            const coep = u.pathname === "/coep";
            res.writeHead(200, { "content-type": "text/html", ...(coep ? { "cross-origin-embedder-policy": "require-corp", "cross-origin-opener-policy": "same-origin" } : {}) });
            const other = `http://localhost:${upPort}`;
            const imgs = coep ? ["none", "cross-origin", "same-origin"] : ["none", "same-origin", "same-site", "cross-origin"];
            return res.end(`<!doctype html>${imgs.map((c) => `<img id="i-${c}" src="${other}/i.gif?corp=${c === "none" ? "" : c}">`).join("")}<script>
                window.out = new Promise((done) => addEventListener("load", () => done(Object.fromEntries([...document.images].map((i) => [i.id, i.naturalWidth])))));
            </script>`);
        });
        await new Promise<void>((r) => upstream.listen(0, "0.0.0.0", () => r()));
        upPort = (upstream.address() as { port: number }).port;
        self = `http://127.0.0.1:${upPort}`;
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

    it("loads what direct loads", async () => {
        for (const path of ["/coep", "/plain"]) {
            const direct = await run(`${self}${path}`);
            const proxied = await run(`${proxyOrigin}/cyrano/http/${self.slice(7)}${path}`);
            expect(proxied, path).toEqual(direct);
        }
        expect(await run(`${self}/coep`)).toEqual({ "i-none": 0, "i-cross-origin": 1, "i-same-origin": 0 });
    }, 60_000);
});
