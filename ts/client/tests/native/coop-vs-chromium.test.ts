// @vitest-environment node
//
// Cross-Origin-Opener-Policy, in real Chromium, direct and through the
// real proxy (spec/Coop.agda; patches/coop.ts). Through the proxy every
// document has the proxy's origin, so two sites that both send
// same-origin (or same-origin-allow-popups) matched and stayed one group:
// the opener's handle stayed live, the popup kept its opener (round K).
// The runtime severs where only the original origins differ; the browser
// still severs where the values do.
//
// Needs the server binary and Playwright's Chromium; `make browser-check`.

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
type Ctx = { newPage(): Promise<Page>; waitForEvent(e: "page", o: object): Promise<Page>; close(): Promise<void> };
type Page = { title(): Promise<string>; waitForLoadState(): Promise<void>; goto(u: string): Promise<unknown>; reload(): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; newContext(): Promise<Ctx>; close(): Promise<void> };



const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

const V: Record<string, string | null> = { so: "same-origin", sap: "same-origin-allow-popups", none: null, bogus: "nonsense" };
const CASES: Array<[string, string, string]> = [["so", "so", "localhost"], ["so", "so", "127.0.0.1"], ["so", "none", "localhost"], ["sap", "none", "localhost"],
    ["sap", "sap", "localhost"], ["none", "so", "localhost"], ["none", "none", "localhost"], ["bogus", "bogus", "localhost"]];

describe.skipIf(!wanted)("Cross-Origin-Opener-Policy, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            const c = V[u.searchParams.get("c") ?? "none"];
            const h: Record<string, string> = { "content-type": "text/html" };
            if (c) h["cross-origin-opener-policy"] = c;
            res.writeHead(200, h);
            if (u.pathname === "/opener") {
                const to = u.searchParams.get("to"), host = u.searchParams.get("host");
                return res.end(`<script>window.out = new Promise((done) => { const w = window.open("http://${host}:${port0}/popup?c=${to}", "nm"); setTimeout(() => {
                  let href; try { href = w.location.href; } catch (e) { href = e.name; }
                  done({ closed: w.closed, href: typeof href === "string" && href.startsWith("http") ? "url" : href }); }, 1500); });</script>`);
            }
            return res.end(`<script>document.title = (window.opener ? "has" : "no") + " opener; name=" + window.name;</script>`);
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

    const run = async (base: string, from: string, to: string, host: string): Promise<string> => {
        const ctx = await browser.newContext();
        const p = await ctx.newPage();
        const pop = ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null);
        await p.goto(`${base}/opener?c=${from}&to=${to}&host=${host}`);
        const o = await p.evaluate(() => (window as unknown as { out: Promise<unknown> }).out);
        const pp = await pop;
        let t = "";
        if (pp) { try { await pp.waitForLoadState(); t = await pp.title(); } catch { t = "?"; } }
        await ctx.close();
        return JSON.stringify(o) + " popup: " + t;
    };

    it("severs as directly", async () => {
        for (const [from, to, host] of CASES) {
            const direct = await run(`http://127.0.0.1:${port0}`, from, to, host);
            const proxied = await run(`${proxyOrigin}/cyrano/http/127.0.0.1:${port0}`, from, to, host);
            expect(proxied, `${from}->${to}@${host}`).toBe(direct);
        }
        expect(await run(`http://127.0.0.1:${port0}`, "so", "so", "localhost")).toContain("no opener");
    }, 180_000);
});
