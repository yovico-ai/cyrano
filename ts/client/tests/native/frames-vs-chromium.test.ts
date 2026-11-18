// @vitest-environment node
//
// Frames as advertising uses them, in real Chromium: empty frames written
// into, frames inside frames, srcdoc, a write method taken off the document
// and called later (Google SafeFrame). Every resource any of them loads
// must go through the proxy — a request to any other host fails the test —
// and the page must still judge which windows are its own.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = {
    goto(u: string): Promise<unknown>;
    evaluate<T>(f: () => T): Promise<T>;
    waitForTimeout(ms: number): Promise<void>;
    on(e: "request", f: (r: { url(): string }) => void): void;
    on(e: "pageerror", f: (e: Error) => void): void;
};
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

describe.skipIf(!wanted)("frames as ads use them, in Chromium", () => {
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
            if (u.startsWith("/cyrano/https/site.example/page")) {
                const boot = `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/page");</script>`;
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(`<!doctype html><html><head>${boot}</head><body></body></html>`);
            }
            // Anything else the page loads through the proxy: an empty answer.
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

    it("every resource of every frame goes through the proxy", async () => {
        const page = await browser.newPage();
        const escaped: string[] = [];
        const proxied: string[] = [];
        const errors: string[] = [];
        page.on("request", (r) => {
            const u = r.url();
            if (!/^https?:/.test(u)) return;
            if (u.startsWith(origin)) proxied.push(u.slice(origin.length));
            else escaped.push(u);
        });
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(`${origin}/cyrano/https/site.example/page`);
        const seen = await page.evaluate(() => {
            const d = document;
            const frame = (): HTMLIFrameElement => { const f = d.createElement("iframe"); d.body.appendChild(f); return f; };
            // 1. SafeFrame: the write method taken off the document, called later.
            const w = d.write;
            w.call(d, '<img src="//ads.example/1-taken-write.png">');
            // 2. An empty frame written into.
            const f2 = frame();
            f2.contentDocument!.open();
            f2.contentDocument!.write('<!doctype html><html><head></head><body><img src="https://ads.example/2-empty-write.png"></body></html>');
            f2.contentDocument!.close();
            // 2b. A whole document written into an empty frame whose script
            // needs <body> (DoubleVerify): the document's own tags reach the parser.
            const f2b = frame();
            f2b.contentDocument!.open();
            f2b.contentDocument!.write('<html><body><script>document.body.appendChild(document.createElement("i"));parent.__bodyOk=document.body.lastChild.tagName</script></body></html>');
            f2b.contentDocument!.close();
            // 3. An empty frame's own innerHTML, setAttribute, style and fetch (its realm's natives).
            const f3 = frame();
            const cw = f3.contentWindow as Window & typeof globalThis;
            cw.document.body.innerHTML = '<img src="https://ads.example/3a-inner.png">';
            const img = cw.document.createElement("img");
            img.setAttribute("src", "https://ads.example/3b-setattr.png");
            cw.document.body.appendChild(img);
            const div = cw.document.createElement("div");
            div.style.backgroundImage = 'url("https://ads.example/3c-style.png")';
            cw.document.body.appendChild(div);
            void cw.fetch("https://ads.example/3d-fetch").catch(() => undefined);
            // 4. A frame inside an empty frame.
            const inner = cw.document.createElement("iframe");
            cw.document.body.appendChild(inner);
            const iw = inner.contentWindow as Window & typeof globalThis;
            iw.document.body.innerHTML = '<img src="https://ads.example/4-nested.png">';
            // 5. srcdoc.
            const f5 = d.createElement("iframe");
            f5.srcdoc = '<img src="https://ads.example/5-srcdoc.png"><script>fetch("https://ads.example/5b-srcdoc-fetch").catch(function(){})<\/script>';
            d.body.appendChild(f5);
            // 6. The page's own style: a view that behaves as the declaration.
            const el = d.createElement("div");
            d.body.appendChild(el);
            el.style.backgroundImage = 'url("https://ads.example/6-top-style.png")';
            const st = el.style;
            st.setProperty("color", "red");
            const style = {
                same: st === el.style, isDecl: st instanceof CSSStyleDeclaration, keys: Object.keys(st).length > 300,
                color: st.getPropertyValue("color"), len: st.length, text: st.cssText.includes("color: red"),
            };
            // 7. Workers from an untyped Blob (Permutive), revoked at once, and from a data: URL.
            const code = 'fetch("https://ads.example/7a-blob-worker").catch(function(){})';
            const bu = URL.createObjectURL(new Blob([code]));
            new Worker(bu);
            URL.revokeObjectURL(bu);
            new Worker("data:application/javascript," + encodeURIComponent(code.replace("7a-blob", "7b-data")));
            // 8. Frames inserted by other routes, then reached by name (no getter sees that).
            const holder = d.createElement("div"); d.body.append(holder);
            const f8 = d.createElement("iframe"); f8.name = "f8"; holder.append(f8);
            (window.frames as unknown as Record<string, Window>)["f8"]!.document.write('<img src="https://ads.example/8a-append.png">');
            holder.insertAdjacentHTML("beforeend", '<div><iframe name="f8b"></iframe></div>');
            (window.frames as unknown as Record<string, Window>)["f8b"]!.document.write('<img src="https://ads.example/8b-markup.png">');
            d.write('<iframe name="f8c"></iframe>');
            (window.frames as unknown as Record<string, Window>)["f8c"]!.document.write('<img src="https://ads.example/8c-written.png">');
            const f8d = d.createElement("iframe"); f8d.name = "f8d"; holder.append(f8d);
            holder.before(f8d); // moved: a new window
            (window.frames as unknown as Record<string, Window>)["f8d"]!.document.write('<img src="https://ads.example/8d-moved.png">');
            // 9. Reading markup back (jQuery's .html()) shows the page's URLs and loads nothing.
            const rb = d.createElement("div"); d.body.appendChild(rb);
            rb.innerHTML = '<img src="https://ads.example/9-readback.png"><link rel="stylesheet" href="https://ads.example/9-readback.css">';
            const readBack = rb.innerHTML.includes('src="https://ads.example/9-readback.png"') && rb.outerHTML.includes("9-readback.css");
            // The page still judges windows: empty frames are its own.
            return {
                style,
                readBack,
                bodyOk: (window as unknown as { __bodyOk?: string }).__bodyOk,
                ownFrameIsReal: f3.contentWindow === cw && cw.document.body !== null,
                nestedIsOwn: inner.contentDocument !== null,
                origin: (cw as unknown as { origin: string }).origin,
                href: cw.location.href,
            };
        });
        await page.waitForTimeout(1500);
        expect(errors).toEqual([]);
        expect(escaped).toEqual([]);
        for (const name of ["6-top-style", "1-taken-write", "2-empty-write", "3a-inner", "3b-setattr", "3c-style", "3d-fetch", "4-nested", "5-srcdoc", "5b-srcdoc-fetch", "7a-blob-worker", "7b-data-worker", "8a-append", "8b-markup", "8c-written", "8d-moved"]) {
            expect(proxied.some((p) => p.includes("/cyrano/https/ads.example/" + name)), name).toBe(true);
        }
        expect(seen).toEqual({
            style: { same: true, isDecl: true, keys: true, color: "red", len: 2, text: true }, bodyOk: "I", readBack: true,
            ownFrameIsReal: true, nestedIsOwn: true, origin: "https://site.example", href: "about:blank" });
    }, 60_000);
});
