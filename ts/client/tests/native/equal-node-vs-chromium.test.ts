// @vitest-environment node
//
// isEqualNode, in real Chromium, direct and proxied: Next.js's head manager
// keeps a server-rendered <script> only when it isEqualNode the element
// React makes of the same text; a rewritten script never was, so it was
// put in again and ran twice (washingtonpost.com, 2026-11-20). The answer
// must be as direct, for a script the server rewrote (marked edits) and
// one whose text a script set through the runtime.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultJsRewriteOptions, rewriteJsSource } from "../../src/js/rewriter";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; waitForFunction(f: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

// The server's rewrite of an inline script: the client's without its
// preamble (window.$rewriter is there already) — a text no client
// rewrite of the same script equals.
const serverRewrite = (src: string): string => {
    const out = rewriteJsSource(src, defaultJsRewriteOptions());
    const end = out.indexOf("$__crn_key__=globalThis.$__crn_key__||0;");
    if (end < 0) return out;
    const after = end + "$__crn_key__=globalThis.$__crn_key__||0;".length;
    const close = out.indexOf("*/", after);
    return out.slice(close + 2);
};

const INLINE = "window.seen = (window.seen || 0) + 1; var where = location.href;";
const PROBE = `<script>
var mk = function (text) { var s = document.createElement("script"); s.id = "x"; s.textContent = text; return s; };
var server = document.getElementById("x");
var made = document.createElement("script"); made.textContent = "var a = top.location.href;";
window.got = {
  serverVsFresh: server.isEqualNode(mk(${JSON.stringify(INLINE)})),
  serverVsOther: server.isEqualNode(mk("var where = 1;")),
  viaInnerHTML: server.isEqualNode((function () { var s = document.createElement("script"); s.id = "x"; s.innerHTML = ${JSON.stringify(INLINE)}; return s; })()),
  viaTextNode: server.isEqualNode((function () { var s = document.createElement("script"); s.id = "x"; s.appendChild(document.createTextNode(${JSON.stringify(INLINE)})); return s; })()),
  viaText: server.isEqualNode((function () { var s = document.createElement("script"); s.id = "x"; s.text = ${JSON.stringify(INLINE)}; return s; })()),
  // Next.js: the new head tag built from markup in a template.
  viaTemplate: (function () { var t = document.createElement("template"); t.innerHTML = '<script async id="t" src="https://cdn.test/x.js"><\\/script>'; var n = t.content.firstChild; return [document.getElementById("t").isEqualNode(n), n.getAttributeNames().join(","), n.getAttribute("src")]; })(),
  madeVsFresh: made.isEqualNode((function () { var s = document.createElement("script"); s.textContent = "var a = top.location.href;"; return s; })()),
  seen: window.seen,
};
</script>`;

describe.skipIf(!wanted)("isEqualNode in Chromium, direct and proxied", () => {
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const proxy = `http://127.0.0.1:${port}`;
            if (req.url === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            if (req.url === "/x.js" || (req.url ?? "").endsWith("/x.js")) { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(""); }
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            if (!(req.url ?? "").startsWith("/cyrano/")) return res.end(`<!doctype html><head><script id="x">${INLINE}</script><script async id="t" src="https://cdn.test/x.js"></script></head><body>${PROBE}</body>`);
            const page = `http://localhost:${port}/p/page`;
            // As the server writes it: the inline script rewritten, its edits marked.
            return res.end(`<!doctype html><head><script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(proxy)},source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(page)});</script>` +
                `<script id="x">${serverRewrite(INLINE)}</script>` +
                `<script async id="t" src="${proxy}/cyrano/https!js/cdn.test/x.js" crn-o="{&#34;src&#34;:&#34;https://cdn.test/x.js&#34;}"></script></head><body>${PROBE.replace(/<script>([\s\S]*)<\/script>/, (_m, js: string) => `<script>${rewriteJsSource(js, defaultJsRewriteOptions())}</script>`)}</body>`);
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch({ args: ["--host-resolver-rules=MAP localhost 127.0.0.1, MAP *.test 127.0.0.1"] });
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const run = async (url: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(url);
        await page.waitForFunction("window.got !== undefined");
        const got = await page.evaluate(() => (window as unknown as { got: unknown }).got);
        await page.close();
        return got;
    };

    it("as direct", async () => {
        const direct = await run(`http://localhost:${port}/p/page`);
        const proxied = await run(`http://127.0.0.1:${port}/cyrano/http/localhost:${port}/p/page`);
        expect(direct).toEqual({ serverVsFresh: true, serverVsOther: false, viaInnerHTML: true, viaTextNode: true, viaText: true,
            viaTemplate: [true, "async,id,src", "https://cdn.test/x.js"], madeVsFresh: true, seen: 1 });
        expect(proxied).toEqual(direct);
    }, 30_000);
});
