// @vitest-environment node
//
// A <style>'s text changed through its text node, in real Chromium, direct
// and proxied. CSS-in-JS writes its rules so — goober (react-hot-toast,
// BigCommerce's hero-image widget on bearsaver.com, 2026-11-22):
// `<style id="_goober">` made with " ", then `sheet.data = sheet.data + css`
// — and the image in that CSS loaded from its origin. Every route
// (data, nodeValue, textContent, appendData, insertData, replaceData,
// deleteData; the element's insertAdjacentText; a nested rule a style
// rule's insertRule adds — round K's built-in survey; a keyframe
// appendRule adds — round J)
// must load through the proxy and read back as written.
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

// 1x1 transparent GIF.
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const SCRIPT = `
const sheet = (id) => { const s = document.createElement("style"); s.id = id; s.innerHTML = " "; document.head.appendChild(s); return s.firstChild; };
const el = (cls) => { const d = document.createElement("div"); d.className = cls; d.textContent = "x"; document.body.appendChild(d); };
const css = (n) => "." + n + "{background-image:url(http://cdn.example/" + n + ".gif)}";
const out = {};
let t = sheet("a"); t.data = t.data + css("data"); el("data"); out.data = t.data;
t = sheet("b"); t.nodeValue = css("nodevalue"); el("nodevalue"); out.nodevalue = t.nodeValue;
t = sheet("c"); t.textContent = css("textcontent"); el("textcontent"); out.textcontent = t.textContent;
t = sheet("d"); t.appendData(css("append")); el("append"); out.append = t.data;
t = sheet("e"); t.insertData(0, css("insert")); el("insert"); out.insert = t.data + "|" + t.length;
t = sheet("f"); t.data = css("old"); t.replaceData(1, 3, "rep"); el("repld"); out.replace = t.data;
t = sheet("g"); t.data = css("deleteme") + css("kept"); t.deleteData(0, css("deleteme").length); el("kept"); out.delete = t.data + "|" + document.getElementById("g").textContent;
try { sheet("h").insertData(5, "x"); out.range = "no error"; } catch (e) { out.range = e.name; }
let s = sheet("i").parentNode; s.insertAdjacentText("beforeend", css("adjend")); el("adjend"); out.adjend = s.textContent;
s = sheet("j").parentNode; s.insertAdjacentText("AfterBegin", css("adjbegin")); el("adjbegin"); out.adjbegin = s.textContent;
s = sheet("k").parentNode; const b = document.createElement("b"); s.appendChild(b); b.insertAdjacentText("afterend", css("adjafter")); el("adjafter"); out.adjafter = s.textContent;
try { sheet("l").parentNode.insertAdjacentText("nowhere", "x"); out.adjbad = "no error"; } catch (e) { out.adjbad = e.name; }
s = sheet("m").parentNode; s.textContent = ".nested { color: red }"; const r = s.sheet.cssRules[0]; r.insertRule("& { background-image: url(http://cdn.example/nested.gif) }", 0); el("nested"); out.nested = r.cssText;
s = sheet("n").parentNode; s.textContent = "@keyframes kf { from { color: red } to { color: blue } } .kf { animation: kf 100s -50s paused }"; const k = s.sheet.cssRules[0]; k.appendRule("50% { background-image: url(http://cdn.example/kf.gif) }"); el("kf"); out.keyframe = k.cssText;
window.out = out;
`;

describe.skipIf(!wanted)("a <style>'s text set through its text node, in Chromium", () => {
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
            if (/\.gif$/.test(u)) {
                res.writeHead(200, { "content-type": "image/gif" });
                return res.end(GIF);
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
        page.on("request", (r) => { const u = r.url(); if (/\.gif$/.test(u)) fetched.push(u); });
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 500)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return { out, fetched: fetched.sort() };
    };

    it("loads through the proxy and reads back as written", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/page");
        expect(direct.fetched.map((u) => u.replace("http://cdn.example/", ""))).toEqual(["adjafter.gif", "adjbegin.gif", "adjend.gif", "append.gif", "data.gif", "insert.gif", "kept.gif", "kf.gif", "nested.gif", "nodevalue.gif", "textcontent.gif"]);
        expect(proxied.out).toEqual(direct.out);
        expect(proxied.fetched).toEqual(direct.fetched.map((u) => u.replace("http://cdn.example/", `${origin}/cyrano/http/cdn.example/`)));
    });
});
