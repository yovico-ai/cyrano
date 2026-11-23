// @vitest-environment node
//
// Workers made inside a worker, in real Chromium, direct and proxied
// (douyin.com, 2026-11-22: a blob worker made data: and blob: decoder
// workers, which ran without the runtime and fetched their origins — the
// blob one with Origin: the proxy's). Every fetch below, from the outer
// worker and from both nested ones, must reach its origin through the
// proxy, the same ones as direct. Requests are recorded by the server:
// what reached the origin directly arrives for host cdn.example.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

// The outer worker's source: fetches, then makes a data: and a blob: worker that fetch.
const INNER = (n: string): string => `fetch("http://cdn.example/${n}.js").then(() => postMessage("${n}"), (e) => postMessage("${n}:" + e.name));`;
const OUTER = `
const done = [];
const report = (m) => { done.push(m); if (done.length === 3) postMessage(done.sort().join(",")); };
fetch("http://cdn.example/outer.js").then(() => report("outer"), (e) => report("outer:" + e.name));
const d = new Worker("data:text/javascript," + encodeURIComponent(${JSON.stringify(INNER("data"))}));
d.onmessage = (e) => report(e.data);
const b = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(INNER("blob"))}], { type: "text/javascript" })));
b.onmessage = (e) => report(e.data);
`;
const SCRIPT = `
const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(OUTER)}], { type: "text/javascript" })));
w.onmessage = (e) => { window.out = e.data; };
`;

describe.skipIf(!wanted)("workers made inside a worker, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";
    let seen: string[] = [];

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u.startsWith("/rewriter.js")) {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            if (u === "/direct" || u.startsWith("/cyrano/https/site.example/page")) {
                const boot = u === "/direct" ? "" : `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/page");</script>`;
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(`<!doctype html><html><head>${boot}</head><body><script>${SCRIPT}</script></body></html>`);
            }
            if (/\.js$/.test(u)) {
                seen.push(`${req.headers.host?.startsWith("cdn.example") ? "DIRECT" : "proxied"} ${u.replace(/^.*\/([a-z]+)\.js$/, "$1")}`);
                res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" });
                return res.end("//");
            }
            res.writeHead(404);
            return res.end();
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch({ args: [`--host-resolver-rules=MAP cdn.example 127.0.0.1:${new URL(origin).port}`] });
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const run = async (path: string): Promise<{ out: unknown; seen: string[] }> => {
        seen = [];
        const page = await browser.newPage();
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 1500)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return { out, seen: [...seen].sort() };
    };

    it("every worker's fetches go through the proxy, as direct", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/page");
        expect(direct.out).toBe("blob,data,outer");
        expect(direct.seen).toEqual(["DIRECT blob", "DIRECT data", "DIRECT outer"]);
        expect(proxied.out).toBe(direct.out);
        expect(proxied.seen).toEqual(["proxied blob", "proxied data", "proxied outer"]);
    });
});
