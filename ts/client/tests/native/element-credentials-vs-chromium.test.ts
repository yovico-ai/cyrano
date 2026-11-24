// @vitest-environment node
//
// Cookies on another origin's element requests, in real Chromium, direct
// and through the real proxy (round I: module scripts, fonts, crossorigin
// elements and EventSource went with the target's cookies — every request
// is same-origin to the browser, and the rewriters give every crossorigin
// element use-credentials). A CORS-mode element request has "same-origin"
// credentials unless use-credentials (marked !cred): what the origin
// receives, as directly (spec Cookies.elementCookies, Attrs.credDest). A
// no-cors fetch() likewise: fetch's default credentials are "same-origin",
// and the runtime's headers cannot go in no-cors — its URL is marked
// !anon (Cookies.markedCookies); a beacon carries them. Sec-Fetch-Storage-
// Access goes with the credentialed ones only, as directly.
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

describe.skipIf(!wanted)("cookies on element requests, in Chromium, through the proxy", () => {
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
            if (k) got[k] = (/tpc=1/.test(req.headers.cookie ?? "") ? "cookie" : "none") + (req.headers["sec-fetch-storage-access"] ? " sfsa=" + String(req.headers["sec-fetch-storage-access"]) : "");
            const a = `http://127.0.0.1:${port0}`;
            const cors = { "access-control-allow-origin": a, "access-control-allow-credentials": "true" };
            if (u.pathname === "/set") { res.writeHead(200, { "content-type": "text/html", "set-cookie": "tpc=1; Path=/; SameSite=None; Secure" }); return res.end("set"); }
            if (u.pathname === "/es") { res.writeHead(200, { "content-type": "text/event-stream", ...cors }); return res.end("data: x\n\n"); }
            if (u.pathname.endsWith(".js")) { res.writeHead(200, { "content-type": "text/javascript", ...cors }); return res.end(""); }
            if (u.pathname.endsWith(".css")) { res.writeHead(200, { "content-type": "text/css", ...cors }); return res.end(""); }
            if (u.pathname.endsWith(".woff2")) { res.writeHead(200, { "content-type": "font/woff2", ...cors }); return res.end(""); }
            if (u.pathname.endsWith(".gif")) { res.writeHead(200, { "content-type": "image/gif", ...cors }); return res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")); }
            const b = `http://localhost:${port0}`;
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><script type=module src="${b}/m.js?k=module"></script><script src="${b}/s.js?k=classic"></script>
                <img crossorigin src="${b}/i.gif?k=imgAnon"><img crossorigin=use-credentials src="${b}/i.gif?k=imgCred"><img src="${b}/i.gif?k=img">
                <link rel=stylesheet crossorigin href="${b}/c.css?k=cssAnon"><style>@font-face{font-family:f;src:url(${b}/f.woff2?k=font)} b{font-family:f}</style><b>x</b>
                <script>new EventSource("${b}/es?k=es"); new EventSource("${b}/es?k=esCred", { withCredentials: true });
                fetch("${b}/i.gif?k=fetchNc", { mode: "no-cors" }); fetch("${b}/i.gif?k=fetchNcCred", { mode: "no-cors", credentials: "include" });
                fetch(new Request("${b}/i.gif?k=fetchNcReq", { mode: "no-cors" })); fetch("${b}/i.gif?k=fetchNcKeep", { mode: "no-cors", keepalive: true });
                navigator.sendBeacon("${b}/i.gif?k=beacon", "x");</script>`);
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
        const at = (host: string, path: string): string => proxied ? `${proxyOrigin}/cyrano/http/${host}:${port0}${path}` : `http://${host}:${port0}${path}`;
        type P = { goto(u: string): Promise<unknown>; waitForTimeout(ms: number): Promise<void> };
        const ctx = await (browser as unknown as { newContext(): Promise<{ newPage(): Promise<P>; close(): Promise<void> }> }).newContext();
        const p = await ctx.newPage();
        await p.goto(at("localhost", "/set"));
        got = {};
        await p.goto(at("127.0.0.1", "/page"));
        await p.waitForTimeout(1500);
        await ctx.close();
        return { ...got };
    };

    it("sends cookies where direct does", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        const c = "cookie sfsa=active";
        expect(direct).toEqual({ module: "none", classic: c, imgAnon: "none", imgCred: c, img: c, cssAnon: "none", font: "none", es: "none", esCred: c,
            fetchNc: "none", fetchNcCred: c, fetchNcReq: "none", fetchNcKeep: "none", beacon: c });
        expect(proxied).toEqual(direct);
    }, 60_000);
});
