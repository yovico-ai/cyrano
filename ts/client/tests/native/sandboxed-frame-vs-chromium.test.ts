// @vitest-environment node
//
// A same-origin frame sandboxed without scripts (allow-same-origin), in real
// Chromium, direct and proxied (round I: it had no runtime, so what its
// parent wrote into it escaped, and its URLs read the proxy's). It gets its
// creator's runtime, told its own URL; its own scripts still do not run.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void>; on(e: "request", f: (r: { url(): string }) => void): void; context(): { on(e: "request", f: (r: { url(): string }) => void): void } };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const SCRIPT = `
window.out = null;
const f = document.createElement("iframe"); f.setAttribute("sandbox", "allow-same-origin"); f.src = "/frame";
f.onload = () => {
  const d = f.contentDocument, rel = (s) => String(s).split(location.origin).join("O");
  d.body.innerHTML = '<img src="https://img.example/p.png?k=inner">';
  new f.contentWindow.Image().src = "https://img.example/p.png?k=ctor";
  out = { url: rel(d.URL), ran: String(f.contentWindow.ran) };
};
document.body.append(f);
`;

describe.skipIf(!wanted)("a sandboxed same-origin frame, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u.startsWith("/rewriter.js")) {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            if (u.startsWith("/a/direct") || u.startsWith("/cyrano/https/site.example/a/page")) {
                const boot = u.startsWith("/a/direct") ? "" : `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js",toolbar:false}).inject();$rewriter.set_location("https://site.example/a/page");</script>`;
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(`<!doctype html><html><head>${boot}</head><body><script>const s = document.createElement("script"); s.text = ${JSON.stringify(SCRIPT).replace(/</g, "\\u003c")}; document.body.appendChild(s);</script></body></html>`);
            }
            if (u === "/frame" || u.startsWith("/cyrano/https!inert/site.example/frame")) {
                res.writeHead(200, { "content-type": "text/html" });
                return res.end("<!doctype html><body><script>window.ran = 1;</script></body>");
            }
            res.writeHead(404);
            return res.end();
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const run = async (path: string): Promise<{ out: unknown; asked: string[] }> => {
        const page = await browser.newPage();
        const asked: string[] = [];
        page.context().on("request", (r) => { const m = /img\.example\/p\.png\?k=(\w+)/.exec(r.url()); if (m) asked.push((r.url().startsWith(origin) ? "proxy " : "OUT ") + m[1]); });
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 800)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return { out, asked: [...new Set(asked)].sort() };
    };

    it("is scripted through the runtime, as its own URL", async () => {
        const direct = await run("/a/direct");
        const proxied = await run("/cyrano/https/site.example/a/page");
        expect(direct.out).toEqual({ url: "O/frame", ran: "undefined" });
        expect(proxied.out).toEqual(direct.out);
        expect(proxied.asked).toEqual(["proxy ctor", "proxy inner"]);
    });
});
