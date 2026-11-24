// @vitest-environment node
//
// A <base href> set again and again, in real Chromium, direct and proxied
// (multistate.us, round H: a relative base stepped up a directory each
// time). HTML resolves a base's href against the document's URL, never the
// base before it (spec/Html.agda documentBase): document.baseURI after each
// value, as directly (compared by path: the origins differ).
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

const SCRIPT = `
const out = [];
const b = document.createElement("base"); document.head.append(b);
for (const v of ["../", "sub/", "../../", "..", "../x/", "./"]) { b.href = v; out.push(new URL(document.baseURI).pathname); }
b.setAttribute("href", "../");
out.push(new URL(document.baseURI).pathname);
window.out = out;
`;

describe.skipIf(!wanted)("a <base href> set again and again, in Chromium", () => {
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
            if (u.startsWith("/a/b/c/direct") || u.startsWith("/cyrano/https/site.example/a/b/c/page")) {
                const boot = u.startsWith("/a/b/c/direct") ? "" : `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/a/b/c/page");</script>`;
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

    const run = async (path: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 300)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return out;
    };

    it("resolves against the document's URL each time, as direct", async () => {
        const direct = await run("/a/b/c/direct");
        const proxied = await run("/cyrano/https/site.example/a/b/c/page");
        expect(direct).toEqual(["/a/b/", "/a/b/c/sub/", "/a/", "/a/b/", "/a/b/x/", "/a/b/c/", "/a/b/"]);
        expect(proxied).toEqual(direct);
    });
});
