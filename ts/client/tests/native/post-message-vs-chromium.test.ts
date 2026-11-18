// @vitest-environment node
//
// postMessage between proxied frames, in real Chromium: what the receiver
// sees must be what it would see natively — event.source the sending
// window, event.origin the sender's original origin — and delivery must
// follow targetOrigin against the original origins. The sender's code is
// not rewritten (as Cloudflare's widget scripts are not), so only the
// native-surface wrapper is in play.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; waitForFunction(f: string): Promise<unknown> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

describe.skipIf(!wanted)("postMessage in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        // Each proxied page loads the runtime (as rewriter.js) and initializes
        // it for its original URL, as the server's bootstrap does.
        const boot = (original: string) =>
            `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(original)});</script>`;
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            res.writeHead(200, { "content-type": u.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" });
            if (u.startsWith("/cyrano/https/top.example/")) {
                return res.end(`<!doctype html><head>${boot("https://top.example/")}</head><body><script>
                    window.got = [];
                    addEventListener("message", (e) => window.got.push({ data: e.data, origin: e.origin,
                        fromChild: e.source === document.querySelector("iframe").contentWindow, fromSelf: e.source === window }));
                </script><iframe src="/cyrano/https/child.example/"></iframe></body>`);
            }
            if (u.startsWith("/cyrano/https/shadow.example/")) {
                // The frame is in a closed shadow tree (as Turnstile's is):
                // window.frames does not list it.
                return res.end(`<!doctype html><head>${boot("https://shadow.example/")}</head><body><div id="host"></div><script>
                    window.got = [];
                    var root = document.getElementById("host").attachShadow({ mode: "closed" });
                    var f = document.createElement("iframe");
                    f.src = "/cyrano/https/child.example/";
                    root.appendChild(f);
                    addEventListener("message", (e) => window.got.push({ data: e.data, origin: e.origin,
                        fromChild: e.source === f.contentWindow, fromSelf: e.source === window, frames: window.length,
                        shadowHtml: root.innerHTML.indexOf("<iframe") === 0 }));
                </script></body>`);
            }
            if (u.startsWith("/cyrano/https/child.example/send.js")) {
                // External, unrewritten sender code.
                return res.end(`parent.postMessage("external", document.referrer.indexOf("shadow.example") >= 0 ? "https://shadow.example" : "https://top.example");`);
            }
            if (u.startsWith("/cyrano/https/child.example/")) {
                return res.end(`<!doctype html><head>${boot("https://child.example/")}</head><body>
                    <script src="/cyrano/https/child.example/send.js"></script>
                    <script>parent.postMessage("inline", document.referrer.indexOf("shadow.example") >= 0 ? "https://shadow.example" : "https://top.example");
                            parent.postMessage("mismatch", "https://elsewhere.example");</script></body>`);
            }
            return res.end("");
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

    it("a frame in a closed shadow tree is still the sender", async () => {
        const page = await browser.newPage();
        await page.goto(`${origin}/cyrano/https/shadow.example/`);
        await page.waitForFunction("window.got && window.got.length >= 2");
        const got = await page.evaluate(() => (window as unknown as { got: unknown[] }).got);
        expect(got).toEqual([
            { data: "external", origin: "https://child.example", fromChild: true, fromSelf: false, frames: 0, shadowHtml: true },
            { data: "inline", origin: "https://child.example", fromChild: true, fromSelf: false, frames: 0, shadowHtml: true },
        ]);
    }, 60_000);

    it("the receiver sees the sending window and its original origin", async () => {
        const page = await browser.newPage();
        const logs: string[] = [];
        (page as unknown as { on(e: string, f: (m: { text(): string }) => void): void }).on("console", (m) => logs.push(m.text()));
        (page as unknown as { on(e: string, f: (m: Error) => void): void }).on("pageerror", (e) => logs.push("pageerror " + e.message));
        await page.goto(`${origin}/cyrano/https/top.example/`);
        await new Promise((r) => setTimeout(r, 1500));
        if (process.env.CYRANO_DEBUG) console.log(JSON.stringify({ logs, got: await page.evaluate(() => (window as unknown as { got: unknown }).got) }, null, 1));
        await page.waitForFunction("window.got && window.got.length >= 2");
        await page.evaluate(() => { window.postMessage("self", "/"); });
        await page.waitForFunction("window.got.length >= 3");
        await new Promise((r) => setTimeout(r, 200)); // anything else would have arrived by now
        const got = await page.evaluate(() => (window as unknown as { got: unknown[] }).got);
        expect(got).toEqual([
            { data: "external", origin: "https://child.example", fromChild: true, fromSelf: false },
            { data: "inline", origin: "https://child.example", fromChild: true, fromSelf: false },
            { data: "self", origin: "https://top.example", fromChild: false, fromSelf: true },
        ]);
    }, 60_000);
});
