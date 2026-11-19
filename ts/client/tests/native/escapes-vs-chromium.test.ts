// @vitest-environment node
//
// Requests that escaped the proxy, or broke, on random sites (2026-11-18),
// in real Chromium on a proxied page:
//   * new FontFace(name, "url(…)") — the browser fetched the font directly (IMDb);
//   * setAttributeNS(xlink, "xlink:href", …) on an SVG image (Facebook avatars);
//   * a srcdoc frame whose <meta> CSP lists only the image's host blocked
//     its proxied image (smile.io);
//   * new StorageEvent(…, {storageArea: localStorage}) and initStorageEvent
//     threw: the page's storage is the runtime's view (macys).
//   * location read by destructuring (`{location: L} = globalThis`) gave
//     the proxy's (Transcend's consent manager refused to run);
//   * a module script built by page code imported straight from the origin
//     (HubSpot on wurthlac); its import.meta.url is the page's URL.
// Each request must reach the proxy, and the page must read back what it wrote.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; waitForTimeout(ms: number): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe.skipIf(!wanted)("escapes and breaks found on random sites, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";
    const hits: string[] = [];

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        const boot = (original: string) =>
            `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(original)});</script>`;
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            hits.push(u);
            if (u === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                res.end(bundle);
                return;
            }
            if (u.endsWith(".png")) { res.writeHead(200, { "content-type": "image/png" }); res.end(PNG); return; }
            if (u.endsWith(".mjs")) { res.writeHead(200, { "content-type": "text/javascript" }); res.end("window.modLoaded = 1;"); return; }
            if (u.endsWith(".woff2")) { res.writeHead(200, { "content-type": "font/woff2" }); res.end(Buffer.alloc(0)); return; }
            if (u.startsWith("/cyrano/https/csp.example/")) {
                // A nonce style policy: a style attribute is refused and reported.
                res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "style-src 'nonce-s'; script-src 'nonce-n' 'unsafe-eval'" });
                res.end(`<!doctype html><head>${boot("https://csp.example/page").replace(/<script/g, '<script nonce="n"')}</head><body></body>`);
                return;
            }
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(`<!doctype html><head>${boot("https://site.example/page")}</head><body></body>`);
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        const addr = server.address();
        origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        const require = createRequire(resolve(__dirname, "../../../e2e/package.json"));
        const { chromium } = require("playwright") as { chromium: { launch(o: object): Promise<Browser> } };
        browser = await chromium.launch({ headless: true });
    }, 60_000);

    afterAll(async () => {
        await browser?.close();
        await new Promise<void>((r) => server?.close(() => r()));
    });

    it("FontFace, xlink:href, srcdoc CSP and StorageEvent", async () => {
        const page = await browser.newPage();
        await page.goto(`${origin}/cyrano/https/site.example/page`);
        const out = await page.evaluate(() => {
            const r: Record<string, unknown> = {};
            new FontFace("f", "url(https://cdn.example/font.woff2) format('woff2')").load().catch(() => {});
            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            const img = document.createElementNS("http://www.w3.org/2000/svg", "image");
            img.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", "https://cdn.example/avatar.png");
            svg.appendChild(img);
            document.body.appendChild(svg);
            const mod = document.createElement("script");
            mod.type = "module";
            mod.textContent = 'import "https://cdn.example/mod.mjs"; window.modMeta = import.meta.url;';
            document.head.appendChild(mod);
            // Rewritten code inside with(…) (Vue's runtime-compiled templates):
            // the with object claims every name (warframe wiki).
            const ctx = new Proxy({ parent: "P", a: { k: 1 }, k: "k" }, { has: (_t, k) => typeof k === "string" && k[0] !== "_", get: (t, k) => (t as Record<string | symbol, unknown>)[k] });
            try {
                r["withParent"] = new Function("ctx", "with(ctx){ return parent }")(ctx);
                r["withMember"] = new Function("ctx", "with(ctx){ return a[k] }")(ctx);
                r["withStrictNested"] = new Function("ctx", "with(ctx){ return (function(){ 'use strict'; return a[k] })() }")(ctx);
            } catch (e) {
                r["withError"] = String(e);
            }
            // location / top / parent read by destructuring (Transcend's
            // consent manager: `{…, parent:Bc, location:Qo, …} = S`).
            r["patternDecl"] = new Function("var S = globalThis; var {location: Qo} = S; return Qo.origin")();
            r["patternAssign"] = new Function("var Q; ({location: Q} = self); return Q.href")();
            r["patternComputed"] = new Function("var k = 'loca' + 'tion'; const {[k]: L} = window; return L.hostname")();
            r["patternParent"] = new Function("const {parent: P} = window; return P === window")();
            r["xlinkReadBack"] = img.getAttributeNS("http://www.w3.org/1999/xlink", "href");
            r["xlinkGetAttribute"] = img.getAttribute("xlink:href");
            const f = document.createElement("iframe");
            f.setAttribute("srcdoc", `<meta http-equiv="Content-Security-Policy" content="img-src https://cdn.example"><img src="https://cdn.example/srcdoc.png">`);
            document.body.appendChild(f);
            try {
                const e = new StorageEvent("storage", { key: "k", storageArea: localStorage });
                r["storageEventArea"] = e.storageArea === localStorage;
                const e2 = document.createEvent("StorageEvent") as StorageEvent;
                e2.initStorageEvent("storage", false, false, "k", null, "v", "https://site.example/page", localStorage);
                r["initStorageEventArea"] = e2.storageArea === localStorage;
            } catch (e) {
                r["storageEventError"] = String(e);
            }
            return r;
        });
        await page.waitForTimeout(1500);
        out["modMeta"] = await page.evaluate(() => (window as unknown as { modMeta?: string }).modMeta);
        expect(out).toEqual({
            modMeta: "https://site.example/page",
            withParent: "P",
            patternDecl: "https://site.example",
            patternAssign: "https://site.example/page",
            patternComputed: "site.example",
            patternParent: true,
            withMember: 1,
            withStrictNested: 1,
            xlinkReadBack: "https://cdn.example/avatar.png",
            xlinkGetAttribute: "https://cdn.example/avatar.png",
            storageEventArea: true,
            initStorageEventArea: true,
        });
        expect(hits).toContain("/cyrano/https/cdn.example/font.woff2");
        expect(hits).toContain("/cyrano/https/cdn.example/avatar.png");
        expect(hits).toContain("/cyrano/https/cdn.example/srcdoc.png");
        expect(hits).toContain("/cyrano/https/cdn.example/mod.mjs");
    }, 60_000);

    // fetchLater: the quota is per original origin (under the proxy every
    // destination is the proxy's — tumblr lost posts to "exceeds its
    // quota"); requests beyond the proxy origin's own quota are deferred by
    // the runtime and sent when the page goes away, as the browser's are.
    it("fetchLater: per-origin quota, and every deferred request sent on leaving", async () => {
        const page = await browser.newPage();
        await page.goto(`${origin}/cyrano/https/site.example/page`);
        const out = await page.evaluate(() => {
            const r: string[] = [];
            // 40 KB, then 30 KB and 20 KB to other origins: natively each
            // origin has room; the proxy's one origin has not.
            for (const [d, n] of [["https://a.example/later", 40000], ["https://b.example/later", 30000], ["https://c.example/later", 20000]] as const) {
                try { (window as unknown as { fetchLater(u: string, i: object): unknown }).fetchLater(d, { method: "POST", body: "x".repeat(n) }); r.push("ok"); } catch (e) { r.push((e as Error).name); }
            }
            return r;
        });
        expect(out).toEqual(["ok", "ok", "ok"]);
        await page.goto(`${origin}/cyrano/https/site.example/other`);
        await page.waitForTimeout(1500);
        const later = hits.filter((h) => h.includes("/later"));
        expect(later.sort()).toEqual(["/cyrano/https/a.example/later", "/cyrano/https/b.example/later", "/cyrano/https/c.example/later"]);
    }, 60_000);

    // The runtime parses written markup to rewrite it; a style attribute
    // parsed anywhere is checked against the page's CSP and reported. The
    // page's innerHTML must report once, as natively (reCAPTCHA reported twice).
    it("a style attribute written by the page reports one CSP violation", async () => {
        const page = await browser.newPage();
        await page.goto(`${origin}/cyrano/https/csp.example/page`);
        const n = await page.evaluate(async () => {
            let count = 0;
            document.addEventListener("securitypolicyviolation", () => count++);
            const d = document.createElement("div");
            document.body.appendChild(d);
            d.innerHTML = '<b style="color:red">x</b>';
            await new Promise((r) => setTimeout(r, 400));
            return count;
        });
        expect(n).toBe(1);
    }, 60_000);
});
