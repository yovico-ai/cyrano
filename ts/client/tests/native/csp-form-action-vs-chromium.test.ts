// @vitest-environment node
//
// A form posted under a CSP form-action, in real Chromium, direct and
// through the real proxy (dzen.ru, 2026-11-23: its sign-in form post to
// Yandex's SSO was refused and the page stayed blank). The policy names
// another host; proxied the form's action is on the proxy, which the
// translated policy admits (spec/Csp.agda navigationTarget): the post
// arrives, as directly.
//
// Runs the server binary (go/assets/cyrano: ./go/scripts/build.sh) on a
// free port. Needs it and Playwright's Chromium; `make browser-check`.

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

describe.skipIf(!wanted)("a form posted under CSP form-action, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let target: Server;
    let proxy: ChildProcess;
    let self = "";
    let other = "";
    let proxyOrigin = "";
    let posted: string[] = [];

    beforeAll(async () => {
        target = createServer((req, res) => { if (req.method === "POST") posted.push(req.url ?? ""); res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html>ok"); });
        await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
        other = `http://localhost:${(target.address() as { port: number }).port}`;
        upstream = createServer((_req, res) => {
            res.writeHead(200, { "content-type": "text/html", "content-security-policy": `form-action ${other}` });
            res.end(`<!doctype html><body><form method="post" action="${other}/sso"><input name="a" value="1"></form><script>document.forms[0].submit()</script></body>`);
        });
        await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
        self = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
        const port = await free();
        proxyOrigin = `http://localhost:${port}`;
        proxy = spawn(binary, ["--assets", resolve(root, "go/assets"), "--log-level", "warn"], {
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
        target?.close();
    });

    const post = async (url: string): Promise<string[]> => {
        posted = [];
        const page = await browser.newPage();
        await page.goto(url);
        await new Promise((r) => setTimeout(r, 1500));
        await page.close();
        return posted;
    };

    it("the post arrives, as directly", async () => {
        expect(await post(`${self}/p`)).toEqual(["/sso"]);
        expect(await post(`${proxyOrigin}/cyrano/http/${self.slice(7)}/p`)).toEqual(["/sso"]);
    });
});
