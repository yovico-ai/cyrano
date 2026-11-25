// @vitest-environment node
//
// window.originAgentCluster, in real Chromium, direct and through the
// real proxy (spec/Oac.agda; patches/oac.ts). Within a browsing context
// group the first document of an origin decides; through the proxy every
// site is the proxy's origin, so the first proxied document decided for
// all (a popup of another site read its opener's ?0: round K).
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

const CASES: Array<[string, string, string]> = [["", "127.0.0.1", ""], ["?0", "127.0.0.1", ""], ["?1", "127.0.0.1", ""], ["?0", "localhost", ""], ["?0", "localhost", "?1"], ["", "localhost", "?0"], ["?0", "127.0.0.1", "?1"]];

describe.skipIf(!wanted)("originAgentCluster, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            const h: Record<string, string> = { "content-type": "text/html" };
            const v = u.searchParams.get("oac");
            if (v) h["origin-agent-cluster"] = v;
            res.writeHead(200, h);
            if (u.pathname === "/pop") return res.end(`<script>document.title = String(window.originAgentCluster)</script>`);
            return res.end(`<script>window.out = new Promise((d) => { window.open("http://${u.searchParams.get("ph")}:${port0}/pop?oac=${encodeURIComponent(u.searchParams.get("po") ?? "")}"); setTimeout(() => d({ self: window.originAgentCluster }), 800); });</script>`);
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

    const run = async (base: string, v: string, ph: string, po: string): Promise<string> => {
        const ctx = await browser.newContext();
        const p = await ctx.newPage();
        const pop = ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null);
        await p.goto(`${base}/opener?oac=${encodeURIComponent(v)}&ph=${ph}&po=${encodeURIComponent(po)}`);
        const o = await p.evaluate(() => (window as unknown as { out: Promise<unknown> }).out);
        const pp = await pop;
        let t = "?";
        if (pp) { try { await pp.waitForLoadState(); t = await pp.title(); } catch { t = "?"; } }
        await ctx.close();
        return JSON.stringify(o) + " popup: " + t;
    };

    it("reads as directly", async () => {
        for (const [v, ph, po] of CASES) {
            const direct = await run(`http://localhost:${port0}`, v, ph, po);
            const proxied = await run(`${proxyOrigin}/cyrano/http/localhost:${port0}`, v, ph, po);
            expect(proxied, `${v}->${ph} ${po}`).toBe(direct);
        }
        expect(await run(`http://localhost:${port0}`, "?0", "127.0.0.1", "")).toContain("popup: true");
    }, 180_000);
});
