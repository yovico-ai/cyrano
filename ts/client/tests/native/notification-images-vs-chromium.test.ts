// @vitest-environment node
//
// A notification's images, in real Chromium, direct and through the real
// proxy (round J: the browser fetched icon, image and badge itself, from
// their origins). The upstream tells an escaped request by a cookie the
// browser holds for it directly; through the proxy it never comes. The
// getters read the page's URLs back.
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

describe.skipIf(!wanted)("a notification\u2019s images, in Chromium, through the proxy", () => {
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
            if (k) { got[k] = /direct=1/.test(String(req.headers.cookie ?? "")) ? "browser" : "proxy"; res.writeHead(200, { "content-type": "image/gif" }); return res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")); }
            const b = `http://localhost:${port0}`;
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><script>
const n = new Notification("hi", { icon: "${b}/i.gif?k=icon", image: "${b}/i.gif?k=image", badge: "${b}/i.gif?k=badge", silent: true });
window.out = [n.icon, n.image, n.badge].map((s) => s.split("${b}").join("X"));
</script>`);
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
        // Headless Chromium fetches no notification image: HEADED=1 (on a
        // nested display) for the escape half; the getters either way.
        browser = await chromium.launch({ headless: process.env.HEADED !== "1", args: ["--mute-audio"] });
    });
    afterAll(async () => {
        await browser?.close();
        proxy?.kill();
        upstream?.close();
    });

    const run = async (proxied: boolean): Promise<unknown> => {
        const url = proxied ? `${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page` : `http://127.0.0.1:${port0}/page`;
        got = {};
        type Ctx = { newPage(): Promise<Page>; close(): Promise<void>; grantPermissions(p: string[], o?: object): Promise<void>; addCookies(c: object[]): Promise<void> };
        const ctx = await (browser as unknown as { newContext(): Promise<Ctx> }).newContext();
        await ctx.grantPermissions(["notifications"]);
        await ctx.addCookies([{ name: "direct", value: "1", domain: "localhost", path: "/", sameSite: "None", secure: true }]);
        const p = await ctx.newPage();
        await p.goto(url);
        await new Promise((res) => setTimeout(res, 2000));
        const out = await p.evaluate(() => (window as unknown as { out: unknown }).out);
        await ctx.close();
        return { out, got: { ...got } };
    };

    it("are fetched through the proxy, and read back as given", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        const shownUrls = ["X/i.gif?k=icon", "X/i.gif?k=image", "X/i.gif?k=badge"];
        expect((direct as { out: unknown }).out).toEqual(shownUrls);
        expect((proxied as { out: unknown }).out).toEqual(shownUrls);
        // (Fetched at all only headed.)
        const fetched = (direct as { got: Record<string, string> }).got;
        if (Object.keys(fetched).length) {
            expect(fetched).toEqual({ icon: "browser", image: "browser", badge: "browser" });
            expect((proxied as { got: unknown }).got).toEqual({ icon: "proxy", image: "proxy", badge: "proxy" });
        }
    }, 60_000);
});
