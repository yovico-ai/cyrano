// @vitest-environment node
//
// A frame the parser inserts with a javascript: URL, in real Chromium,
// direct and through the real proxy (spec/Frames.agda frameRuntime
// pendingFrame; JsUrl.agda). Its code is rewritten and runs in the frame's
// initial about:blank as a task after the insertion: the frame must have
// the runtime by then. Given it only at its load event, the code threw
// `$rewriter is not defined` (my.adp.com, geico.app.link: a frame written
// into an empty frame, `javascript:window.parent.parent[k](window)`).
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const binary = process.env.CYRANO_BINARY ?? resolve(root, "go/assets/cyrano");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(binary);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: string, f: (x: Error) => void): void };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };

const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

describe.skipIf(!wanted)("a parser-inserted frame's javascript: URL, in Chromium", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((_req, res) => {
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><body>
                <iframe src="javascript:void (window.parent.__a = typeof window.parent.document)"></iframe>
                <script>
                const f = document.createElement("iframe");
                document.body.appendChild(f);
                f.contentDocument.write('<iframe src="javascript:void (window.parent.parent.__b = typeof window.parent.parent.document)"></iframe>');
                f.contentDocument.close();
                </script>`);
        });
        await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
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

    const run = async (proxied: boolean): Promise<{ a: unknown; b: unknown; errors: string[] }> => {
        const url = proxied ? `${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page` : `http://127.0.0.1:${port0}/page`;
        const ctx = await browser.newContext();
        const p = await ctx.newPage();
        const errors: string[] = [];
        p.on("pageerror", (e) => errors.push(String(e.message)));
        await p.goto(url);
        await p.evaluate(() => new Promise((r) => setTimeout(r, 1000)));
        const got = await p.evaluate(() => ({ a: (window as unknown as { __a: unknown }).__a, b: (window as unknown as { __b: unknown }).__b }));
        await ctx.close();
        return { ...got, errors };
    };

    it("runs as directly, the runtime in place", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        expect(direct).toEqual({ a: "object", b: "object", errors: [] });
        expect(proxied).toEqual(direct);
    }, 60_000);
});
