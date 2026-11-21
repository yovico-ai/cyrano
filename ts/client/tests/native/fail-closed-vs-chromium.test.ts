// @vitest-environment node
//
// The bootstrap fails closed, in real Chromium: when the runtime's script
// does not load, no script of the page runs and nothing it names is
// fetched outside the proxy. On windowscentral.com (2026-11-21) 31 ad
// frames lost their runtime to Chrome's limit on requests in flight; their
// scripts ran without it and their user-sync pixels went to the origins.
//
// The bootstrap is the client's (runtime/bootstrap-html.ts); the server's
// writes the same guard (Go: htmlrewrite.FailClosed, held equal by
// TestFailClosedSameInBothRuntimes). Needs the built bundle and
// Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootstrapHtml } from "../../src/runtime/bootstrap-html";
import type { ClientConfig } from "../../src/config";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Req = { url(): string };
type Page = { goto(u: string, o?: object): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

// What the page itself holds after the bootstrap: a script that sets a
// flag and reaches another host as page code does (fetch, an image, a
// frame — what the runtime proxifies), and an element after it.
const PAGE_BODY = `<script>window.ran = true; fetch("http://elsewhere.example/leak").catch(() => {});` +
    `new Image().src = "http://elsewhere.example/pixel.gif";` +
    `const f = document.createElement("iframe"); f.src = "http://elsewhere.example/frame"; document.body.appendChild(f);</script>` +
    `<p id=after>after</p>`;

describe.skipIf(!wanted)("the bootstrap fails closed, in Chromium", () => {
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
            if (u.startsWith("/broken-runtime.js")) {
                res.writeHead(503);
                return res.end();
            }
            const m = /^\/cyrano\/https\/site\.example\/(ok|broken)$/.exec(u);
            if (m) {
                const cfg: ClientConfig = { apiBaseURL: origin, cacheKey: "", source: m[1] === "ok" ? "/rewriter.js" : "/broken-runtime.js", version: "0", rewrite_css_selectors: false };
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(`<!doctype html><html><head>${buildBootstrapHtml(cfg, "https://site.example/" + m[1])}</head><body>${PAGE_BODY}</body></html>`);
            }
            res.writeHead(204);
            return res.end();
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const run = async (which: string): Promise<{ ran: unknown; after: boolean; outside: string[] }> => {
        const page = await browser.newPage();
        const outside: string[] = [];
        page.on("request", (r) => { const u = r.url(); if (/^https?:/.test(u) && !u.startsWith(origin)) outside.push(u); });
        await page.goto(`${origin}/cyrano/https/site.example/${which}`, { waitUntil: "commit", timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1500);
        const got = await page.evaluate(() => ({ ran: (window as unknown as { ran?: unknown }).ran, after: document.getElementById("after") !== null }));
        await page.close();
        return { ...got, outside };
    };

    it("runs the page when the runtime loaded", async () => {
        const ok = await run("ok");
        expect(ok.ran).toBe(true);
        expect(ok.outside).toEqual([]);
    });

    it("runs nothing and fetches nothing outside the proxy when it did not", async () => {
        const broken = await run("broken");
        expect(broken.ran).toBeUndefined();
        expect(broken.after).toBe(false);
        expect(broken.outside).toEqual([]);
    });
});
