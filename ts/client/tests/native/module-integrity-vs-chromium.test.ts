// @vitest-environment node
//
// A module script's and a modulepreload's own integrity, in real Chromium,
// direct and through the real proxy (spec/Sri.agda carry). A module's URL is
// its identity in the module map: marked with its integrity, the entry a
// page loads with `<script type=module integrity>` was another module than
// the one its chunks import back by "./entry.js" — evaluated twice
// (gigabyte.com: Nuxt's Pinia installed in one copy, read from the other,
// the page unrendered). The document now keeps the integrity; the proxy
// still fails a module whose bytes do not match.
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

const ENTRY = `window.entryRuns = (window.entryRuns || 0) + 1; export const app = { id: Math.random() };`;
const CHUNK = `import { app } from "./entry.js"; window.chunkApp = app; window.ran.push("chunk");`;
const MAIN = `import { app } from "./entry.js"; import "./chunk.js"; window.same = window.chunkApp === app; window.ran.push("main");`;
const sha = (s: string): string => "sha384-" + createHash("sha384").update(s).digest("base64");

const PAGE = (): string => `<!doctype html>
<script>window.ran = []; window.errs = [];</script>
<link rel="modulepreload" href="./entry.js" integrity="${sha(ENTRY)}" crossorigin>
<link rel="modulepreload" href="./chunk.js" integrity="${sha(CHUNK)}" crossorigin>
<script type="module" src="./entry.js" integrity="${sha(ENTRY)}" onerror="errs.push('entry')"></script>
<script type="module" src="./main.js" integrity="${sha(MAIN)}" onerror="errs.push('main')"></script>
<script type="module" src="./tampered.js" integrity="${sha("something else")}" onerror="errs.push('tampered')"></script>
<script>window.out = new Promise((ok) => setTimeout(() => ok({ ran: [...ran].sort(), errs: [...errs].sort(), entryRuns: window.entryRuns, same: window.same }), 1500));</script>`;

describe.skipIf(!wanted)("module integrity keeps one module per URL, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            const js = (s: string) => { res.writeHead(200, { "content-type": "text/javascript" }); res.end(s); };
            if (u.pathname === "/entry.js") return js(ENTRY);
            if (u.pathname === "/chunk.js") return js(CHUNK);
            if (u.pathname === "/main.js") return js(MAIN);
            if (u.pathname === "/tampered.js") return js(`window.ran.push("tampered");`);
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

    it("evaluates the entry once and fails a tampered module, as directly", async () => {
        const direct = await run(`http://127.0.0.1:${port0}/page`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page`);
        expect(direct).toEqual({ ran: ["chunk", "main"], errs: ["tampered"], entryRuns: 1, same: true });
        expect(proxied).toEqual(direct);
    }, 120_000);
});
