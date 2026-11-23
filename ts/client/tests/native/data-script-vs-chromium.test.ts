// @vitest-environment node
//
// Scripts given data: URLs, in real Chromium, direct and proxied: their
// text is JavaScript the rewriter never saw (vegrecipesofindia.com, 2026-11-22:
// a WordPress PWA module, inserted by a delay-until-interaction loader as
// <script type=module src="data:…">, imported its origin direct). The
// runtime reads such a URL as the browser does (spec/DataUrl.agda) and gives
// the script a data: URL of the rewritten text: every import below must go
// through the proxy, the same ones as direct, and `src` read back as written.
// (Markup the server sends: Go TestE2E_DataScriptRewritten.)
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
type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const SCRIPT = `
const b64 = (s) => btoa(s);
const imp = (n) => 'import("http://cdn.example/' + n + '.js")';
const out = {};
// Classic, by the property, base64.
let s = document.createElement("script"); s.src = "data:text/javascript;base64," + b64(imp("classic")); document.head.appendChild(s);
out.classic = s.src.slice(0, 40) + "|" + s.getAttribute("src").length;
// Module, by setAttribute, percent-encoded; a static import and a relative one (fails both ways).
s = document.createElement("script"); s.type = "module";
const m = 'import "http://cdn.example/static.js"; ' + imp("module");
s.setAttribute("src", "data:text/javascript," + encodeURIComponent(m)); document.head.appendChild(s);
out.module = s.getAttribute("src") === "data:text/javascript," + encodeURIComponent(m);
// Written markup.
document.write('<script src="data:text/javascript;base64,' + b64(imp("written")) + '"><\\/script>');
// import() of a data: module, in script text the page sets: literal, and through a variable.
const dm = (n) => "data:text/javascript," + encodeURIComponent('import "http://cdn.example/' + n + '.js";');
s = document.createElement("script"); s.text = 'import("' + dm("literal") + '").then(() => { window.dyn = "ok"; }, (e) => { window.dyn = e.name; });'; document.head.appendChild(s);
s = document.createElement("script"); s.text = 'const u = "' + dm("variable") + '"; import(u);'; document.head.appendChild(s);
// No JavaScript: not loaded.
s = document.createElement("script"); s.type = "text/plain"; s.src = "data:text/javascript;base64," + b64(imp("data")); document.head.appendChild(s);
window.out = out;
`;

describe.skipIf(!wanted)("scripts given data: URLs, in Chromium", () => {
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
            if (u === "/direct" || u.startsWith("/cyrano/https/site.example/page")) {
                const boot = u === "/direct" ? "" : `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/page");</script>`;
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(`<!doctype html><html><head>${boot}</head><body><script>${SCRIPT}</script></body></html>`);
            }
            if (/\.js$/.test(u)) {
                res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" });
                return res.end("export {};");
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

    const run = async (path: string): Promise<{ out: unknown; dyn: unknown; fetched: string[] }> => {
        const page = await browser.newPage();
        const fetched: string[] = [];
        page.on("request", (r) => { const u = r.url(); if (/cdn\.example.*\.js$/.test(u)) fetched.push(u); });
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 1000)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        const dyn = await page.evaluate(() => (window as unknown as { dyn: unknown }).dyn);
        await page.close();
        return { out, dyn, fetched: fetched.sort() };
    };

    it("loads through the proxy, as direct, and reads back as written", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/page");
        const name = (u: string): string => u.replace(/^.*\/([a-z]+)\.js$/, "$1");
        expect(direct.fetched.map(name)).toEqual(["classic", "literal", "module", "static", "variable", "written"]);
        expect(proxied.out).toEqual(direct.out);
        expect(proxied.dyn).toEqual(direct.dyn);
        for (const u of proxied.fetched) expect(u).toMatch(new RegExp(`^${origin}/cyrano/http(![a-z]+)*/cdn\\.example/`));
        expect(proxied.fetched.map(name).sort()).toEqual(direct.fetched.map(name));
    });
});
