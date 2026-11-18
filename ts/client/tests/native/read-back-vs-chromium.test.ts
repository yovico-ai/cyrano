// @vitest-environment node
//
// Reading markup back, in real Chromium: a page as the server rewrites it
// (proxified attributes, each element's originals in the `crn-o` attribute)
// must show its scripts the markup the page wrote — in a parser-inserted
// script placed right after the elements, with a MutationObserver watching
// from the top — and markup set by scripts must read back as set.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

describe.skipIf(!wanted)("reading markup back in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const o = `http://${req.headers.host}`;
            if (req.url === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            const P = `${o}/cyrano/https/site.example`;
            const orig = (m: Record<string, string | null>) => `crn-o="${JSON.stringify(m).replace(/"/g, "&quot;")}"`;
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            // What the Go HTML rewriter emits for the page below (see
            // htmlrewrite.withOriginals), with the page's own scripts.
            return res.end(`<!doctype html><html><head><script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(o)},source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/dir/page");document.currentScript.remove();</script>
<script>window.seenByObserver=[];new MutationObserver(function(rs){rs.forEach(function(r){if(r.type==="attributes")seenByObserver.push(r.attributeName)})}).observe(document,{attributes:true,subtree:true});</script></head>
<body><a id="a" class="k" href="${P}/up?q=1" ${orig({ href: "../up?q=1" })}>x</a><img id="i" alt="a" src="${P}/dir/i.png" srcset="${P}/dir/a.png 1x, ${P}/dir/b.png 2x" ${orig({ src: "i.png", srcset: "a.png 1x, b.png 2x" })}><link id="l" rel="stylesheet" href="${P}/s.css" ${orig({ href: "/s.css", integrity: "sha384-abc" })}>
<script>var a=document.getElementById("a"),i=document.getElementById("i"),l=document.getElementById("l");
window.early={href:a.getAttribute("href"),resolved:a.href,src:i.getAttribute("src"),srcset:i.srcset,srcsetAttr:i.getAttribute("srcset"),
 integrity:l.getAttribute("integrity"),hasIntegrity:l.hasAttribute("integrity"),hasShadow:a.hasAttribute("crn"+"-o"),names:a.getAttributeNames().join(","),
 attrValue:a.getAttributeNode("href").value,outer:a.outerHTML,bodyHas:document.body.innerHTML.indexOf("crn"+"-o")>=0||document.body.innerHTML.indexOf("/cyr"+"ano/")>=0};</script>
<div id="late"></div></body></html>`);
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

    it("page scripts read the markup the page wrote", async () => {
        const page = await browser.newPage();
        await page.goto(`${origin}/cyrano/https/site.example/dir/page`);
        const r = await page.evaluate(() => {
            const w = window as unknown as { early: Record<string, unknown>; seenByObserver: string[] };
            const late = document.getElementById("late")!;
            // Markup set by a script reads back as set, relative URLs relative.
            late.innerHTML = '<a href="../rel">r</a><img srcset="x.png 1x,  y.png 2x">';
            const a = late.querySelector("a")!;
            const img = late.querySelector("img")!;
            const made = document.createElement("a");
            made.setAttribute("href", "./made?x#f");
            const viaIdl = document.createElement("img");
            viaIdl.src = "pic.png";
            const s = document.createElement("script");
            s.textContent = "var where = location.href;";
            const clone = a.cloneNode(true) as HTMLAnchorElement;
            made.removeAttribute("href");
            return {
                early: w.early, observer: w.seenByObserver,
                lateInner: late.innerHTML, lateHref: a.getAttribute("href"), lateResolved: a.href, lateSrcset: img.srcset,
                realLateHref: Object.getOwnPropertyDescriptor(Element.prototype, "getAttribute") ? a.outerHTML : "",
                madeAfterRemove: made.getAttribute("href"), viaIdlAttr: viaIdl.getAttribute("src"), viaIdlProp: viaIdl.src,
                scriptText: s.textContent, scriptInner: s.innerHTML, cloneHref: clone.getAttribute("href"),
                serialized: new XMLSerializer().serializeToString(a),
                getAttributeText: Function.prototype.toString.call(Element.prototype.getAttribute),
            };
        });
        if (process.env.CYRANO_DEBUG) console.log("BODY", await page.evaluate(() => document.body.innerHTML));
        expect(r.early).toEqual({
            href: "../up?q=1", resolved: "https://site.example/up?q=1", src: "i.png",
            srcset: "a.png 1x, b.png 2x", srcsetAttr: "a.png 1x, b.png 2x",
            integrity: "sha384-abc", hasIntegrity: true, hasShadow: false, names: "id,class,href",
            attrValue: "../up?q=1", outer: '<a id="a" class="k" href="../up?q=1">x</a>', bodyHas: false,
        });
        expect(r.observer).toEqual([]);
        expect(r.lateInner).toBe('<a href="../rel">r</a><img srcset="x.png 1x,  y.png 2x">');
        expect([r.lateHref, r.lateResolved, r.lateSrcset]).toEqual(["../rel", "https://site.example/rel", "x.png 1x,  y.png 2x"]);
        expect([r.madeAfterRemove, r.viaIdlAttr, r.viaIdlProp]).toEqual([null, "pic.png", "https://site.example/dir/pic.png"]);
        expect([r.scriptText, r.scriptInner]).toEqual(["var where = location.href;", "var where = location.href;"]);
        expect(r.cloneHref).toBe("../rel");
        expect(r.serialized).toContain('href="../rel"');
        expect(r.getAttributeText).toBe("function getAttribute() { [native code] }");
    }, 60_000);
});
