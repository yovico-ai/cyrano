// @vitest-environment node
//
// CSS Typed OM, in real Chromium, direct and proxied (nfl.com, 2026-11-22;
// distilled: each route below loaded its image from the origin). Every
// image must load through the proxy, the same ones as direct. Requests are
// recorded by the server: what reached the origin directly arrives for
// host cdn.example.
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
const u = (n) => "url(http://cdn.example/" + n + ".gif)";
const box = () => { const d = document.createElement("div"); d.style.width = "20px"; d.style.height = "20px"; document.body.appendChild(d); return d; };
box().attributeStyleMap.set("background-image", u("set"));
box().attributeStyleMap.append("background-image", u("append"));
box().attributeStyleMap.set("background-image", CSSStyleValue.parse("background-image", u("parse")));
box().attributeStyleMap.set("background-image", CSSStyleValue.parseAll("background-image", u("parseall"))[0]);
const s = document.createElement("style"); s.textContent = ".r{width:20px;height:20px}"; document.head.appendChild(s);
const r = document.createElement("div"); r.className = "r"; document.body.appendChild(r);
s.sheet.cssRules[0].styleMap.set("background-image", u("rule"));
const l = document.createElement("ul"); const li = document.createElement("li"); li.textContent = "x"; l.appendChild(li); document.body.appendChild(l);
l.attributeStyleMap.set("list-style-image", u("list"));
`;

describe.skipIf(!wanted)("CSS Typed OM, in Chromium", () => {
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
            if (/\.gif$/.test(u)) {
                seen.push(`${req.headers.host?.startsWith("cdn.example") ? "DIRECT" : "proxied"} ${u.replace(/^.*\/([a-z]+)\.gif$/, "$1")}`);
                res.writeHead(200, { "content-type": "image/gif" });
                return res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
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

    const run = async (path: string): Promise<string[]> => {
        seen = [];
        const page = await browser.newPage();
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 1500)));
        await page.close();
        return [...seen].sort();
    };

    it("every image loads through the proxy, as direct", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/page");
        expect(direct).toEqual(["DIRECT append", "DIRECT list", "DIRECT parse", "DIRECT parseall", "DIRECT rule", "DIRECT set"]);
        expect(proxied).toEqual(direct.map((s) => s.replace("DIRECT", "proxied")));
    });
});
