// @vitest-environment node
//
// An import map's "integrity" section, in real Chromium, direct and through
// the real proxy (spec/ImportMap.agda integrityEntries). The browser is
// given the map with it emptied (a rewritten module never matches the
// original's hash); the proxy checks a listed module by its entry. Before,
// a module whose bytes did not match ran through the proxy.
//
// Needs the server binary and Playwright's Chromium; `make browser-check`.

import { createHash } from "node:crypto";
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
type Page = { goto(u: string): Promise<unknown>; reload(): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };



const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

const MOD = (name: string): string => `window.ran.push(${JSON.stringify(name)});`;
const MAIN = `import "./dep.js"; import "./dep-ok.js"; window.ran.push("main");`;
const sha = (s: string): string => "sha384-" + createHash("sha384").update(s).digest("base64");

const PAGE = (): string => `<!doctype html>
<script>window.ran = []; window.errs = [];</script>
<script type="importmap">${JSON.stringify({
    imports: { lib: "./lib.js" },
    integrity: {
        "./bad.js": sha("something else"),
        "./ok.js": sha(MOD("ok")),
        "./dep.js": sha("not dep"),
        "./dep-ok.js": sha(MOD("dep-ok")),
        "./lib.js": sha("not lib"),
        "./dyn.js": sha("not dyn"),
    },
})}</script>
<script type="module" src="./bad.js" onerror="errs.push('bad')"></script>
<script type="module" src="./ok.js" onerror="errs.push('ok')"></script>
<script type="module" src="./plain.js" onerror="errs.push('plain')"></script>
<script type="module" src="./main.js" onerror="errs.push('main')"></script>
<script type="module">import("lib").then(() => ran.push("lib-ok"), (e) => errs.push("lib " + e.name));
import("./dyn.js").then(() => ran.push("dyn-ok"), (e) => errs.push("dyn " + e.name));</script>
<script>window.out = new Promise((ok) => setTimeout(() => ok({ ran: [...ran].sort(), errs: [...errs].sort() }), 1500));</script>`;

describe.skipIf(!wanted)("import map integrity, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            const js = (s: string) => { res.writeHead(200, { "content-type": "text/javascript" }); res.end(s); };
            if (u.pathname === "/main.js") return js(MAIN);
            const m = /^\/([a-z-]+)\.js$/.exec(u.pathname);
            if (m) return js(MOD(m[1]!));
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(PAGE());
        });
        await new Promise<void>((r) => upstream.listen(0, "0.0.0.0", () => r()));
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

    const run = async (url: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(url);
        const out = await page.evaluate(() => (window as unknown as { out: Promise<unknown> }).out);
        await page.close();
        return out;
    };

    it("fails a listed module whose bytes do not match, as directly", async () => {
        const direct = await run(`http://127.0.0.1:${port0}/page`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page`);
        expect(direct).toMatchObject({ ran: ["ok", "plain"], errs: ["bad", "dyn TypeError", "lib TypeError", "main"] });
        expect(proxied).toEqual(direct);
    }, 120_000);
});
