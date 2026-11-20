// @vitest-environment node
//
// The frame mark (spec/Containment.agda destFrame, Frames.agda embedderOf),
// in real Chromium: however a document gives a frame of its own its URL —
// markup it writes, the src property, setAttribute, the child's location
// from the parent — the request the proxy sees is marked; a frame
// navigating itself (its own location, a link in it) asks unmarked, which
// is how the proxy tells a frame's parent from the frame's own previous
// document. And the page reads back what it wrote, as direct.
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

// The parent: four frames, each given its URL another way; then it sends
// the fourth elsewhere through its location.
const PARENT = `
var read = {};
document.body.insertAdjacentHTML("beforeend", '<iframe id="m" src="/f/markup"></iframe>');
var p = document.createElement("iframe"); p.id = "p"; p.src = "/f/prop"; document.body.appendChild(p);
var a = document.createElement("iframe"); a.id = "a"; a.setAttribute("src", "/f/attr"); document.body.appendChild(a);
var l = document.createElement("iframe"); l.id = "l"; l.src = "/f/first"; document.body.appendChild(l);
l.onload = function () { l.onload = null; l.contentWindow.location.href = "/f/by-parent"; };
read.src = [document.getElementById("m").src, p.src, a.getAttribute("src"), a.src].map(function (u) { return u.replace(location.origin, ""); });
window.read = read;
`;
// A frame that then navigates itself (once).
const SELF = `if (location.pathname === "/f/markup") location.href = "/f/by-itself";`;

describe.skipIf(!wanted)("the frame mark in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let port = 0;
    const asked: string[] = [];

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        const rw = (js: string): string => rewriteJsSource(js, defaultJsRewriteOptions());
        server = createServer((req, res) => {
            const proxy = `http://127.0.0.1:${port}`;
            const u = req.url ?? "";
            if (u === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            const m = /^\/cyrano\/http((?:![a-z-]+)*)\/([^/]+)(\/.*)$/.exec(u);
            if (m && m[3]!.startsWith("/f/")) asked.push(`${m[3]}${m[1] === "" ? "" : " " + m[1]}`);
            const path = m ? m[3]! : u;
            const boot = (href: string): string => `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(proxy)},source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(href)});</script>`;
            const js = path === "/p/page" ? PARENT : SELF;
            if (!m) return res.end(`<!doctype html><body><script>${js}</script>`);
            return res.end(`<!doctype html>${boot(`http://localhost:${port}${path}`)}<body><script>${rw(js)}</script>`);
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch({ args: ["--host-resolver-rules=MAP localhost 127.0.0.1"] });
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const run = async (url: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(url);
        await page.waitForFunction("window.read !== undefined && frames.length === 4");
        await new Promise((r) => setTimeout(r, 700)); // the frames' own navigations
        const got = await page.evaluate(() => (window as unknown as { read: unknown }).read);
        await page.close();
        return got;
    };

    it("a document's frames ask marked; a frame navigating itself does not; the page reads what it wrote", async () => {
        const direct = await run(`http://localhost:${port}/p/page`);
        expect(direct).toEqual({ src: ["/f/markup", "/f/prop", "/f/attr", "/f/attr"] });
        asked.length = 0;
        expect(await run(`http://127.0.0.1:${port}/cyrano/http/localhost:${port}/p/page`)).toEqual(direct);
        expect(asked.slice().sort()).toEqual([
            "/f/attr !frame", "/f/by-itself", "/f/by-parent !frame", "/f/first !frame", "/f/markup !frame", "/f/prop !frame",
        ]);
    }, 30_000);
});
