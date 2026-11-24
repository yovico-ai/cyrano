// @vitest-environment node
//
// CSS values the style engine loads from Web Animations keyframes and
// CSS.registerProperty, in real Chromium, proxied (round H probe: the images
// went to their origin). Element#animate, new KeyframeEffect, setKeyframes
// (list and property-indexed forms) and a <url> property's initialValue:
// every image is asked of the proxy, none of the origin, and the page's own
// keyframe objects are left as it made them.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void>; on(e: "request", f: (r: { url(): string }) => void): void };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const SCRIPT = `
const mk = (id) => { const d = document.createElement("div"); d.id = id; d.style.cssText = "width:50px;height:50px"; document.body.append(d); return d; };
const u = (k) => "url(https://img.example/p.png?k=" + k + ")";
const kf = [{ backgroundImage: u(1) }, { backgroundImage: u(2) }];
mk("a").animate(kf, { duration: 5000 });
mk("b").animate({ backgroundImage: [u(3), u(4)] }, { duration: 5000 });
new Animation(new KeyframeEffect(mk("c"), [{ listStyleImage: u(5) }, { listStyleImage: u(5) }], 5000)).play();
const e = new KeyframeEffect(mk("d"), null, 5000); e.setKeyframes([{ backgroundImage: u(6) }, { backgroundImage: u(6) }]); new Animation(e).play();
CSS.registerProperty({ name: "--u", syntax: "<url>", inherits: false, initialValue: u(7) });
mk("f").style.background = "var(--u)";
window.out = { kept: kf[0].backgroundImage };
`;

describe.skipIf(!wanted)("Web Animations and registered properties, in Chromium", () => {
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
            if (u.startsWith("/a/direct") || u.startsWith("/cyrano/https/site.example/a/page")) {
                const boot = u.startsWith("/a/direct") ? "" : `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/a/page");</script>`;
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(`<!doctype html><html><head>${boot}</head><body><script>const s = document.createElement("script"); s.text = ${JSON.stringify(SCRIPT).replace(/</g, "\\u003c")}; document.body.appendChild(s);</script></body></html>`);
            }
            res.writeHead(404);
            return res.end();
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const run = async (path: string): Promise<{ out: unknown; asked: string[] }> => {
        const page = await browser.newPage();
        const asked: string[] = [];
        page.on("request", (r) => { const m = /img\.example\/p\.png\?k=(\d)/.exec(r.url()); if (m) asked.push((r.url().startsWith(origin) ? "proxy " : "OUT ") + m[1]); });
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 800)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return { out, asked: [...new Set(asked)].sort() };
    };

    it("asks the proxy for every image, as direct asks the origin", async () => {
        const direct = await run("/a/direct");
        const proxied = await run("/cyrano/https/site.example/a/page");
        expect(direct.asked).toEqual(["OUT 1", "OUT 3", "OUT 5", "OUT 6", "OUT 7"].concat(direct.asked.includes("OUT 2") ? ["OUT 2"] : []).concat(direct.asked.includes("OUT 4") ? ["OUT 4"] : []).sort());
        expect(proxied.asked).toEqual(direct.asked.map((x) => x.replace("OUT", "proxy")));
        expect(proxied.out).toEqual({ kept: "url(https://img.example/p.png?k=1)" });
    });
});
