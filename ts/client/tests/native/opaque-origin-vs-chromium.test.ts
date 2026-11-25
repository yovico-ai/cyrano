// @vitest-environment node
//
// A sandboxed document, in real Chromium, direct and proxied. Its origin
// is opaque, so its requests to the proxy are cross-origin to the browser,
// which runs CORS itself; the runtime's Crn-I / Crn-C headers made a
// simple request non-simple and the browser sent a preflight the page did
// not cause (Target's PerimeterX frame, 2026-11-19; spec/Fetch.agda
// namesContext). And it reads `origin` "null" and `document.domain` "",
// not the page's original origin (spec/Frames.agda selfOrigin,
// documentDomain).
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Frame = { url(): string; evaluate<T>(f: () => T): Promise<T> };
type Page = { on(e: "console", f: (m: { text(): string }) => void): void; goto(u: string): Promise<unknown>; frames(): Frame[]; waitForTimeout(ms: number): Promise<void>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

// The frame's script: an XHR and a fetch to another origin, and what the
// document says its origin is.
const PROBE = `<script>
window.got = new Promise(function (done) {
  var out = { origin: String(self.origin), domain: document.domain };
  // writing document.cookie in it: the setter's own SecurityError (round J: proxied, the getter's words)
  try { document.cookie = "a=1"; out.cookieSet = "ok"; } catch (e) { out.cookieSet = e.name + ": " + e.message; }
  var x = new XMLHttpRequest();
  x.open("GET", "http://b.test:PORT/data?x");
  x.onload = function () {
    out.xhr = x.status + " " + x.responseText;
    out.headers = [x.getResponseHeader("x-shown"), x.getResponseHeader("x-hidden"), /x-shown/i.test(x.getAllResponseHeaders()), /x-hidden/i.test(x.getAllResponseHeaders())];
    fetch("http://b.test:PORT/data?f").then(function (r) { return r.text().then(function (t) { out.fetch = r.status + " " + r.type + " " + t; done(out); }); },
      function (e) { out.fetch = "rejects " + e.name; done(out); });
  };
  x.onerror = function () { out.xhr = "error"; done(out); };
  x.send();
});
</script>`;

describe.skipIf(!wanted)("a sandboxed document in Chromium, direct and proxied", () => {
    let browser: Browser;
    let server: Server;
    let port = 0;
    const preflights: string[] = [];

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const proxy = `http://127.0.0.1:${port}`;
            if (req.url === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            // Proxied: /cyrano/http/<host>/<path>, as the server routes it.
            const m = /^\/cyrano\/http\/([^/]+)(\/.*)$/.exec(req.url ?? "");
            const host = m ? m[1]! : req.headers.host ?? "";
            const path = m ? m[2]! : req.url ?? "";
            if (req.method === "OPTIONS") preflights.push(`${m ? "proxied" : "direct"} ${host}${path}`);
            if (path.startsWith("/data")) {
                res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*", "access-control-expose-headers": "x-shown", "x-shown": "s", "x-hidden": "h" });
                return res.end("data");
            }
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            const probe = PROBE.replace(/PORT/g, String(port));
            const boot = (href: string) => `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(proxy)},source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(href)});</script>`;
            if (path === "/page") {
                const src = m ? `${proxy}/cyrano/http/a.test:${port}/frame` : "/frame";
                return res.end(`<!doctype html>${m ? boot(`http://a.test:${port}/page`) : ""}<iframe sandbox="allow-scripts" src="${src}"></iframe>`);
            }
            if (path === "/frame") return res.end(`<!doctype html>${m ? boot(`http://a.test:${port}/frame`) : ""}${probe}`);
            res.writeHead(404);
            return res.end();
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch({ args: ["--host-resolver-rules=MAP *.test 127.0.0.1"] });
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    // The browser's own "Refused to get unsafe header" lines: the page's
    // read of x-hidden, and nothing of the runtime's (it asked for its
    // carrier header, which CORS does not expose to an opaque origin).
    const refusals: string[][] = [];
    const run = async (url: string): Promise<unknown> => {
        const page = await browser.newPage();
        const refused: string[] = [];
        refusals.push(refused);
        page.on("console", (m) => { if (/Refused to get unsafe header/.test(m.text())) refused.push(m.text()); });
        await page.goto(url);
        let frame: Frame | undefined;
        for (let i = 0; i < 50 && !frame; i++) {
            frame = page.frames().find((f) => f.url().endsWith("/frame"));
            if (!frame) await page.waitForTimeout(100);
        }
        const got = await frame!.evaluate(() => (window as unknown as { got: Promise<unknown> }).got);
        await page.close();
        return got;
    };

    it("requests and origin as direct, no preflight", async () => {
        const direct = await run(`http://a.test:${port}/page`);
        const proxied = await run(`http://127.0.0.1:${port}/cyrano/http/a.test:${port}/page`);
        expect(direct).toMatchObject({ cookieSet: "SecurityError: Failed to set the 'cookie' property on 'Document': The document is sandboxed and lacks the 'allow-same-origin' flag.", origin: "null", domain: "", xhr: "200 data", headers: ["s", null, true, false], fetch: "200 cors data" });
        expect(proxied).toEqual(direct);
        expect(refusals[0]).toEqual(['Refused to get unsafe header "x-hidden"']);
        expect(refusals[1]).toEqual(refusals[0]);
        expect(preflights).toEqual([]);
    }, 30_000);
});
