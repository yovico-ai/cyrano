// @vitest-environment node
//
// A <script> whose text was written while it was no JavaScript (type
// text/plain) and whose type then became JavaScript, in real Chromium,
// direct and proxied. Consent managers hold scripts so and flip the type on
// consent; Cookiebot's cloneScriptTag sets the text on a fresh script and
// then its type (jackery.com, 2026-11-22: 19 Shopify modules loaded from
// their origin). The browser judges a script when it is inserted
// (spec/Html.agda scriptKind), so its text must be rewritten then: every
// import below must go through the proxy, the same ones as direct, and the
// text read back as written.
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

const code = (n: string): string => `import("http://cdn.example/${n}.js")`;

// Parsed as data, its type changed, inserted again.
const MARKUP = `<script type="text/plain" id="parsed">${code("parsed")}</script>`;

const SCRIPT = `
const code = (n) => 'import("http://cdn.example/' + n + '.js")';
const out = {};
// Cookiebot's order: type text/plain, text, then a module type.
let s = document.createElement("script"); s.type = "text/plain"; s.text = code("module"); s.type = "module"; document.body.appendChild(s);
out.module = s.text;
// Attributes and textContent, a classic JavaScript type.
s = document.createElement("script"); s.setAttribute("type", "text/plain"); s.textContent = code("classic"); s.setAttribute("type", "text/javascript"); document.body.append(s);
out.classic = s.textContent;
// Classic by removing the type.
s = document.createElement("script"); s.type = "text/plain"; s.text = code("removed"); s.removeAttribute("type"); document.head.insertBefore(s, null);
out.removed = s.text;
// In a fragment.
s = document.createElement("script"); s.type = "text/plain"; s.text = code("fragment"); s.type = "";
const f = document.createDocumentFragment(); const d = document.createElement("div"); d.appendChild(s); f.appendChild(d); document.body.appendChild(f);
out.fragment = s.text;
// A parsed text/plain script, its type changed, inserted again.
s = document.getElementById("parsed"); s.type = "module"; document.body.appendChild(s);
out.parsed = s.text;
// Still data: not loaded.
s = document.createElement("script"); s.type = "text/plain"; s.text = code("data"); document.body.appendChild(s);
out.data = s.text;
// The plain case.
s = document.createElement("script"); s.text = code("plain"); document.body.appendChild(s);
out.plain = s.text;
window.out = out;
`;

describe.skipIf(!wanted)("a script made JavaScript after its text was written, in Chromium", () => {
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
                return res.end(`<!doctype html><html><head>${boot}</head><body>${MARKUP}<script>${SCRIPT}</script></body></html>`);
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

    const run = async (path: string): Promise<{ out: unknown; fetched: string[] }> => {
        const page = await browser.newPage();
        const fetched: string[] = [];
        page.on("request", (r) => { const u = r.url(); if (/cdn\.example.*\.js$/.test(u)) fetched.push(u); });
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 800)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return { out, fetched: fetched.sort() };
    };

    it("loads through the proxy, as direct, and reads back as written", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/page");
        const name = (u: string): string => u.replace(/^.*\/([a-z]+)\.js$/, "$1");
        expect(direct.fetched.map(name)).toEqual(["classic", "fragment", "module", "parsed", "plain", "removed"]);
        expect(proxied.out).toEqual(direct.out);
        // Every one through the proxy (marked or not), none from its origin.
        for (const u of proxied.fetched) expect(u).toMatch(new RegExp(`^${origin}/cyrano/http(![a-z]+)*/cdn\\.example/`));
        expect(proxied.fetched.map(name).sort()).toEqual(direct.fetched.map(name));
    });
});
