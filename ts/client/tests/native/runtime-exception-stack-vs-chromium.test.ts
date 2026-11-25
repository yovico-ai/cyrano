// @vitest-environment node
//
// DOMExceptions the runtime throws itself, in real Chromium, direct and
// proxied (round J: they had no stack — V8 gives one to what Blink throws,
// not to `new DOMException`; error reporters read it). Each has one, its
// first line V8's header, its frames the page's.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void>; on(e: "request", f: (r: { url(): string }) => void): void };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const SCRIPT = `
const rel = (s) => String(s).split(location.origin).join("O");
const t = (f) => { try { f(); return "no throw"; } catch (e) { const st = e.stack; return typeof st + " | " + (typeof st === "string" ? rel(st.split("\\n")[0]) + " | " + (st.split("\\n").length > 1) : ""); } };
window.out = {
  push: t(() => history.pushState({}, "", "http://other.example/")),
  worker: t(() => new Worker("http://other.example/w.js")),
};
`;

describe.skipIf(!wanted)("the runtime\u2019s DOMExceptions, in Chromium", () => {
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
        page.on("request", (r) => { const m = /img\.example\/p\.png\?k=(\d)/.exec(r.url()); if (m) asked.push((r.url().startsWith(origin) ? "proxy " : "OUT ") + m[1]); });
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 800)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return { out, asked: [...new Set(asked)].sort() };
    };

    it("have a stack, as natively", async () => {
        const direct = await run("/a/direct");
        const proxied = await run("/cyrano/https/site.example/a/page");
        const d = direct.out as Record<string, string>, p = proxied.out as Record<string, string>;
        for (const k of ["push", "worker"]) {
            expect(d[k]).toMatch(/^string \| SecurityError: .* \| true$/);
            expect(p[k]!.split(" | ")[0]).toBe("string");
            expect(p[k]!.split(" | ")[2]).toBe("true");
        }
        // The worker's header names the same URLs both sides (the page's origin as O).
        expect(p.worker).toBe(d.worker);
    });
});
