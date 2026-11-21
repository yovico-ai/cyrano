// @vitest-environment node
//
// insertAdjacentHTML and createContextualFragment parse where the markup
// lands, in real Chromium, direct and proxied. Before or after an element
// the context is its parent; at its start or end, the element itself; a
// range that starts in text, the text's parent. The runtime took the
// element itself for every position: markup placed after a <script>
// (flashtalking's ad tags, time.now and thehill.com, 2026-11-21) was read
// as script text, left as written, and its iframe loaded from the origin.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Req = { url(): string };
type Page = { goto(u: string): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

// Runs in the page: inserts, then describes the tree it made.
const SCRIPT = `
const box = document.getElementById("box");
const s = document.getElementById("anchor");
s.insertAdjacentHTML("afterEnd", '<div id=a1><iframe src="https://ads.example/after.html"></iframe><img src="https://ads.example/after.png"></div>');
s.insertAdjacentHTML("beforebegin", '<div id=a2><img src="//ads.example/before.png"></div>');
const st = document.getElementById("style");
st.insertAdjacentHTML("beforeend", '<img src="https://ads.example/in-style.png">');
box.insertAdjacentHTML("AFTERBEGIN", '<img src="https://ads.example/start.png">');
const t = document.getElementById("text").firstChild;
const r = document.createRange(); r.setStart(t, 1); r.setEnd(t, 1);
document.getElementById("text").appendChild(r.createContextualFragment('<img src="https://ads.example/range.png">'));
window.shape = [...document.querySelectorAll("#box *, #text *")].map((e) => e.tagName + (e.id ? "#" + e.id : "")).join(" ") + " | style: " + st.textContent;
`;

const PAGE = (boot: string): string => `<!doctype html><html><head>${boot}<style id=style>p{}</style></head><body>` +
    `<div id=box><script id=anchor>void 0</script></div><p id=text>ab</p><script>${SCRIPT}</script></body></html>`;

describe.skipIf(!wanted)("insertAdjacentHTML parses where the markup lands, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            if (u === "/direct") {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(PAGE(""));
            }
            if (u.startsWith("/cyrano/https/site.example/page")) {
                const boot = `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/page");</script>`;
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(PAGE(boot));
            }
            res.writeHead(204);
            return res.end();
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch({ args: ["--host-resolver-rules=MAP ads.example 127.0.0.1"] });
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const run = async (path: string): Promise<{ shape: string; fetched: string[] }> => {
        const page = await browser.newPage();
        const fetched: string[] = [];
        page.on("request", (r) => { const u = r.url(); if (/ads\.example|\/cyrano\/https(?:![a-z]+)*\/ads\.example/.test(u)) fetched.push(u); });
        await page.goto(origin + path);
        await page.waitForTimeout(600);
        const shape = await page.evaluate(() => (window as unknown as { shape: string }).shape);
        await page.close();
        return { shape, fetched };
    };

    it("makes the same tree, and fetches everything through the proxy", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/page");
        expect(proxied.shape).toBe(direct.shape);
        const names = (xs: string[]): string[] => xs.map((u) => u.replace(/^.*ads\.example/, "")).sort();
        expect(names(direct.fetched)).toEqual(["/after.html", "/after.png", "/before.png", "/range.png", "/start.png"]);
        expect(names(proxied.fetched)).toEqual(names(direct.fetched));
        expect(proxied.fetched.filter((u) => !u.startsWith(origin))).toEqual([]);
    });
});
