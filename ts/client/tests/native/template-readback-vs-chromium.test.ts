// @vitest-environment node
//
// Reading back markup inside a <template>, in real Chromium, direct and
// through the real proxy (heart.org, 2026-11-22: Vue compiles its in-DOM
// templates from #app.innerHTML, and every link inside a <template> read
// back as the proxied URL). The server rewrites the content's URLs (a
// clone of it loads them); the page reads them as written: the
// container's and the template's serialization, the content's attributes,
// and a link's href in the content's inert document, which resolves
// against nothing as directly.
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

const PAGE = `<!doctype html><body><div id="app"><nav><template id="t" v-slot:dropdown><ul><li><a href="/en/healthy-living" class="l">x</a></li></ul><img src="/i.png" alt=""></template><a href="/en/out">o</a></nav></div>
<script>
const app = document.getElementById("app"), t = document.getElementById("t");
window.out = { app: app.innerHTML, tpl: t.innerHTML, outer: t.outerHTML, xml: new XMLSerializer().serializeToString(t),
  content: Array.from(t.content.querySelectorAll("a, img")).map((e) => e.getAttribute("href") + e.getAttribute("src") + "|" + (e.href || e.src)) };
</script></body>`;

const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

describe.skipIf(!wanted)("markup inside a <template> read back, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";

    beforeAll(async () => {
        upstream = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); });
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
    });

    const read = async (url: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(url);
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return out;
    };

    it("reads as direct", async () => {
        const direct = await read(`${self}/p`);
        const proxied = await read(`${proxyOrigin}/cyrano/http/${self.slice(7)}/p`);
        expect(proxied).toEqual(direct);
    });
});
