// @vitest-environment node
//
// HTTP Basic authentication across sites, in real Chromium, direct and
// through the real proxy (round K: credentials given to one site were sent
// to another whose 401 named the same realm, with no prompt — the browser
// keeps them by origin and realm, and through the proxy every site is one
// origin). Each site's realm is its own (spec/Auth.agda): site b is
// challenged and gets nothing of a's; a cross-origin image raises no
// challenge. The user answers only a's challenge (CDP Fetch.authRequired).
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

describe.skipIf(!wanted)("HTTP authentication across sites, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;
    let received: string[] = [];

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            const host = (req.headers.host ?? "").split(":")[0];
            if (u.pathname.startsWith("/auth")) {
                if (!req.headers.authorization) {
                    res.writeHead(401, { "www-authenticate": 'Basic realm="r1"', "content-type": "text/plain" });
                    return res.end("no");
                }
                received.push(host + " " + Buffer.from(req.headers.authorization.split(" ")[1] ?? "", "base64").toString());
                res.writeHead(200, { "content-type": u.pathname.endsWith(".gif") ? "image/gif" : "text/html" });
                return res.end("ok");
            }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<img src="http://localhost:${port0}/auth/img.gif">`);
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

    const run = async (proxied: boolean): Promise<{ shown: string[]; received: string[] }> => {
        const at = (host: string, path: string): string => proxied ? `${proxyOrigin}/cyrano/http/${host}:${port0}${path}` : `http://${host}:${port0}${path}`;
        received = [];
        const shown: string[] = [];
        type P = { goto(u: string): Promise<unknown>; waitForTimeout(ms: number): Promise<void> };
        type C = { newPage(): Promise<P>; close(): Promise<void>; newCDPSession(p: P): Promise<{ send(m: string, a?: object): Promise<unknown>; on(e: string, f: (x: { requestId: string; request: { url: string } }) => void): void }> };
        const ctx = await (browser as unknown as { newContext(): Promise<C> }).newContext();
        const p = await ctx.newPage();
        const cdp = await ctx.newCDPSession(p);
        await cdp.send("Fetch.enable", { handleAuthRequests: true, patterns: [{ urlPattern: "*" }] });
        cdp.on("Fetch.requestPaused", (e) => { void cdp.send("Fetch.continueRequest", { requestId: e.requestId }); });
        cdp.on("Fetch.authRequired", (e) => {
            const site = /127\.0\.0\.1/.test(e.request.url.replace(proxyOrigin, "")) ? "a" : "b";
            shown.push(site + (/img\.gif/.test(e.request.url) ? " img" : " page"));
            void cdp.send("Fetch.continueWithAuth", { requestId: e.requestId, authChallengeResponse: site === "a" ? { response: "ProvideCredentials", username: "userA", password: "pwA" } : { response: "CancelAuth" } });
        });
        await p.goto(at("127.0.0.1", "/auth/page")).catch(() => undefined);
        await p.goto(at("localhost", "/auth/page")).catch(() => undefined);
        await p.goto(at("127.0.0.1", "/plain")).catch(() => undefined);
        await p.waitForTimeout(800);
        await ctx.close();
        return { shown, received };
    };

    it("keeps each site's apart, as directly", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        expect(direct).toEqual({ shown: ["a page", "b page"], received: ["127.0.0.1 userA:pwA"] });
        expect(proxied).toEqual(direct);
    }, 60_000);
});
