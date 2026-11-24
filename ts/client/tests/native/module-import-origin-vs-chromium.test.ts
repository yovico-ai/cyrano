// @vitest-environment node
//
// A module's imports, in real Chromium, direct and through the real proxy
// (round I: import() named the proxy as its Origin): a script's own
// requests are its document's — Origin and Sec-Fetch-Site by the page's
// origin, through a module graph (the proxy notes the document each script
// was loaded for), and the CORS check by it: a module whose
// Access-Control-Allow-Origin names another origin does not load.
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

describe.skipIf(!wanted)("a module\u2019s imports, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    let got: Record<string, string> = {};
    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            const k = u.searchParams.get("k");
            const b = `http://localhost:${port0}`;
            const js = { "content-type": "text/javascript", "access-control-allow-origin": "*" };
            if (k) got[k] = String(req.headers.origin ?? "none").split(`http://127.0.0.1:${port0}`).join("O") + " " + String(req.headers["sec-fetch-site"]);
            if (u.pathname === "/m.js") { res.writeHead(200, js); return res.end(`import "${b}/s.js?k=static"; import("${b}/d.js?k=dynamic").then(() => { window.done = 1; }); import("${b}/deny.js?k=deny").then(() => { window.deny = "loaded"; }, (e) => { window.deny = e.name; });`); }
            if (u.pathname === "/deny.js") { res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "http://other.example" }); return res.end("window.ran = 1;"); }
            if (u.pathname === "/s.js") { res.writeHead(200, js); return res.end(`import("${b}/d2.js?k=nested");`); }
            if (u.pathname.endsWith(".js")) { res.writeHead(200, js); return res.end(""); }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><script type=module src="${b}/m.js?k=top"></script>`);
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

    const run = async (proxied: boolean): Promise<Record<string, string>> => {
        const url = proxied ? `${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page` : `http://127.0.0.1:${port0}/page`;
        got = {};
        const p = await browser.newPage();
        await p.goto(url);
        await p.evaluate(() => new Promise((res) => setTimeout(res, 1500)));
        const deny = await p.evaluate(() => String((window as unknown as { deny?: unknown }).deny));
        await p.close();
        return { ...got, denyResult: deny };
    };

    it("name the page\u2019s origin, as directly", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        expect(direct).toEqual({ top: "O cross-site", static: "O cross-site", dynamic: "O cross-site", nested: "O cross-site", deny: "O cross-site", denyResult: "TypeError" });
        expect(proxied).toEqual(direct);
    }, 60_000);
});
