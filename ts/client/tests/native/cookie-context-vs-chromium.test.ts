// @vitest-environment node
//
// A context's cookies, in real Chromium, direct and through the real proxy
// (round H probes: a cross-site frame listed and stored Lax cookies, and
// Partitioned cookies were one jar for every top-level site). Three
// loopback names are three sites, all trustworthy (Secure cookies over
// http): a = 127.0.0.1, b = localhost, c = 127.0.0.2. b, framed by a, sets
// cookies by its response and by script; what b reads framed by a, framed
// by c and on top, and what cookieStore says of them, as directly
// (spec/Cookies.agda CookieCtx: storableIn, placedIn, inCtx).
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

describe.skipIf(!wanted)("a context's cookies, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/set") {
                res.writeHead(200, { "content-type": "text/html", "set-cookie": u.searchParams.getAll("c") });
                return res.end("<p>set");
            }
            if (u.pathname === "/frame") {
                res.writeHead(200, { "content-type": "text/html" });
                return res.end(`<iframe src="${u.searchParams.get("src")}"></iframe>`);
            }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end("<p>page");
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

    // Every step on one page of a fresh context: direct, or each URL proxied.
    const run = async (proxied: boolean): Promise<string[]> => {
        const at = (host: string, path: string): string => proxied ? `${proxyOrigin}/cyrano/http/${host}:${port0}${path}` : `http://${host}:${port0}${path}`;
        const raw = (host: string, path: string): string => `http://${host}:${port0}${path}`;
        const ctx = await (browser as unknown as { newContext(): Promise<{ newPage(): Promise<P>; close(): Promise<void> }> }).newContext();
        type F = { evaluate<T>(f: (a: string) => T, a?: string): Promise<T> };
        type P = { goto(u: string): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; frames(): F[]; evaluate<T>(f: () => T): Promise<T> };
        const p = await ctx.newPage();
        const log: string[] = [];
        const framed = async (top: string, inner: string): Promise<F> => {
            await p.goto(at(top, "/frame?src=" + encodeURIComponent(raw(inner, "/x"))));
            await p.waitForTimeout(400);
            return p.frames()[1]!;
        };
        const sets = ["pp=1; Secure; SameSite=None; Partitioned; Path=/", "pn=1; SameSite=None; Partitioned; Path=/", "up=1; Secure; SameSite=None; Path=/",
            "lax=1; SameSite=Lax; Path=/", "def=1; Path=/", "same=part; Secure; SameSite=None; Partitioned; Path=/"];
        await p.goto(at("127.0.0.1", "/frame?src=" + encodeURIComponent(raw("localhost", "/set?" + sets.map((c) => "c=" + encodeURIComponent(c)).join("&")))));
        await p.waitForTimeout(500);
        log.push("b under a: " + await (await framed("127.0.0.1", "localhost")).evaluate(() => document.cookie));
        log.push("b under c: " + await (await framed("127.0.0.2", "localhost")).evaluate(() => document.cookie));
        await p.goto(at("localhost", "/set?c=" + encodeURIComponent("same=unpart; Secure; SameSite=None; Path=/") + "&c=" + encodeURIComponent("fp=1; Secure; Partitioned; Path=/")));
        log.push("top b: " + await p.evaluate(() => document.cookie));
        const f = await framed("127.0.0.1", "localhost");
        log.push("b under a again: " + await f.evaluate(() => document.cookie));
        await f.evaluate(() => { document.cookie = "js=1; Secure; SameSite=None; Partitioned"; document.cookie = "jslax=1"; document.cookie = "jsnone=1; Secure; SameSite=None"; });
        log.push("b under a after writes: " + await f.evaluate(() => document.cookie));
        log.push("b under c after writes: " + await (await framed("127.0.0.2", "localhost")).evaluate(() => document.cookie));
        await p.goto(at("localhost", "/x"));
        log.push("top b after: " + await p.evaluate(() => document.cookie));
        log.push("cookieStore top b: " + await p.evaluate(async () => JSON.stringify((await (window as unknown as { cookieStore: { getAll(): Promise<{ name: string; partitioned: boolean }[]> } }).cookieStore.getAll()).map((c) => [c.name, c.partitioned]))));
        await ctx.close();
        return log;
    };

    it("stores, sends and lists as directly", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        expect(direct[0]).toBe("b under a: pp=1; up=1; same=part");
        expect(proxied).toEqual(direct);
    }, 90_000);
});
