// @vitest-environment node
//
// The navigation net (src/patches/navigation.ts, spec/Route.agda
// netDestination) in real Chromium: a navigation a document starts for
// another origin, by code the rewriter never saw — here a script left
// exactly as the origin sent it — does not leave the proxy; it arrives at
// the destination's proxified URL. Every way a document navigates:
// location by a computed key, location.href / assign / replace,
// document.location, a setTimeout string, a link's click, a form (its
// method and body kept), window.open in the same window, a meta refresh.
// And the page's own navigate listeners see only the navigation that
// replaces it, to the original URL.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; url(): string; waitForURL(u: RegExp, o?: { timeout: number }): Promise<void>; evaluate<T, A>(f: (a: A) => T, a: A): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

// Each run as unrewritten code: OTHER is another origin's URL prefix.
const WAYS: Record<string, string> = {
    "location by a computed key": `var k = "location"; window[k] = OTHER + "a";`,
    "location.href": `location.href = OTHER + "b";`,
    "location.assign": `location.assign(OTHER + "c");`,
    "location.replace": `location.replace(OTHER + "d");`,
    "document.location": `document.location = OTHER + "e";`,
    "a setTimeout string": `setTimeout("location = '" + OTHER + "f'", 0);`,
    "a link's click": `var a = document.createElement("a"); a.setAttribute("href", OTHER + "g"); HTMLElement.prototype.click.call(a);`,
    "window.open in the same window": `window.open(OTHER + "h", "_self");`,
    "a meta refresh": `document.head.insertAdjacentHTML("beforeend", "<meta http-equiv=refresh content='0;url=" + OTHER + "i'>");`,
};

describe.skipIf(!wanted)("the navigation net in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let port = 0;
    const direct: string[] = [];   // requests that reached the other origin unproxied
    const posted: string[] = [];

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const proxy = `http://127.0.0.1:${port}`;
            const u = req.url ?? "";
            if (u === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            if ((req.headers.host ?? "").startsWith("other.test")) direct.push(u);
            const m = /^\/cyrano\/http\/([^/]+)(\/.*)$/.exec(u);
            if (m && req.method === "POST") {
                let body = "";
                req.on("data", (c: Buffer) => { body += c.toString(); });
                req.on("end", () => { posted.push(`${m[1]}${m[2]} ${body}`); res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html>posted"); });
                return;
            }
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            if (!m) return res.end("<!doctype html>unproxied");
            const page = `http://${m[1]}${m[2]}`;
            return res.end(`<!doctype html><head><script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(proxy)},source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(page)});</script></head><body>`);
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

    const start = async (): Promise<Page> => {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${port}/cyrano/http/page.test:${port}/start`);
        return page;
    };
    // Unrewritten code, as a script the page inserts natively would be if the rules missed it.
    const runRaw = (page: Page, js: string): Promise<void> => page.evaluate(({ js, other }) => {
        (0, eval)(`var OTHER = ${JSON.stringify(other)};` + js);
    }, { js, other: `http://other.test:${port}/` });

    it("no navigation leaves the proxy, however it is started", async () => {
        const failed: string[] = [];
        for (const [name, js] of Object.entries(WAYS)) {
            const page = await start();
            direct.length = 0;
            await runRaw(page, js);
            const path = /OTHER \+ "(\w)"|OTHER \+ "(\w)'|url=" \+ OTHER \+ "(\w)'/.exec(js);
            const letter = path ? (path[1] ?? path[2] ?? path[3])! : "?";
            await page.waitForURL(new RegExp(`/cyrano/http/other\\.test:${port}/${letter}$`), { timeout: 5000 }).catch(() => undefined);
            if (page.url() !== `http://127.0.0.1:${port}/cyrano/http/other.test:${port}/${letter}` || direct.length > 0) {
                failed.push(`${name}: at ${page.url()}, unproxied requests ${JSON.stringify(direct)}`);
            }
            await page.close();
        }
        expect(failed).toEqual([]);
    }, 90_000);

    it("a form keeps its method and body", async () => {
        const page = await start();
        direct.length = 0;
        await runRaw(page, `var f = document.createElement("form"); f.setAttribute("method", "post"); f.setAttribute("action", OTHER + "form");
            var i = document.createElement("input"); i.setAttribute("name", "q"); i.setAttribute("value", "v 1"); f.appendChild(i);
            Node.prototype.appendChild.call(document.body, f); HTMLFormElement.prototype.submit.call(f);`);
        await page.waitForURL(new RegExp(`/cyrano/http/other\\.test:${port}/form$`), { timeout: 5000 }).catch(() => undefined);
        expect(page.url()).toBe(`http://127.0.0.1:${port}/cyrano/http/other.test:${port}/form`);
        expect(posted).toEqual([`other.test:${port}/form q=v+1`]);
        expect(direct).toEqual([]);
        await page.close();
    }, 30_000);

    it("the page's own navigate listener sees the navigation once, to the original URL", async () => {
        const page = await start();
        const seen = await page.evaluate(({ other }) => new Promise<string[]>((done) => {
            const urls: string[] = [];
            // (Added by the page after the runtime's: it must not see the cancelled one.)
            const s = document.createElement("script");
            s.textContent = `navigation.addEventListener("navigate", function (e) { window.__seen.push(e.destination.url); e.preventDefault(); });`;
            (window as unknown as { __seen: string[] }).__seen = urls;
            document.head.appendChild(s);
            (0, eval)(`var k = "location"; window[k] = ${JSON.stringify(other + "z")};`);
            setTimeout(() => done(urls), 300);
        }), { other: `http://other.test:${port}/` });
        expect(seen).toEqual([`http://other.test:${port}/z`]);
        await page.close();
    }, 30_000);
});
