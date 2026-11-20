// @vitest-environment node
//
// The portal toolbar (src/ui/toolbar.ts, spec/Toolbar.agda) in real
// Chromium: a page with it reads exactly as the same page direct — node
// counts, serialization, a tree walk, layout boxes, hit tests (inside the
// toolbar's box too), style sheets, body.shadowRoot — and sees no mutation
// record. The user's clicks on it never reach a page listener: the home
// button goes to the portal, the grip slides it, and a click where it was
// is the page's again.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TOOLBAR, initialLeft, rightEnd } from "../../src/ui/toolbar";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Mouse = { click(x: number, y: number): Promise<void>; move(x: number, y: number, o?: { steps: number }): Promise<void>; down(): Promise<void>; up(): Promise<void> };
type Page = { goto(u: string): Promise<unknown>; url(): string; mouse: Mouse; waitForFunction(f: string): Promise<unknown>; waitForURL(u: string | RegExp): Promise<void>; waitForTimeout(ms: number): Promise<void>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(o?: object): Promise<Page>; close(): Promise<void> };

// A flex body (the toolbar must stay out of its flow), content under the
// toolbar's box, and listeners of every kind the toolbar's events could reach.
const PAGE = `<style>body{display:flex;flex-wrap:wrap;gap:4px;margin:0} .c{width:150px;height:40px;background:#ccd}</style>
<div class="c" id="a">a</div><div class="c" id="b">b</div>text<div class="c" id="z">z</div>
<script>
var seen = [], records = 0;
["pointerdown","pointerup","pointermove","mousedown","mouseup","click","dblclick","contextmenu"].forEach(function (t) {
  window.addEventListener(t, function (e) { seen.push(t + ":" + (e.target.id || e.target.nodeName) + "@" + e.clientX); }, true);
});
new MutationObserver(function (rs) { records += rs.length; }).observe(document, { subtree: true, childList: true, attributes: true });
function snap() {
  var r = function (e) { var q = e.getBoundingClientRect(); return [q.x, q.y, q.width, q.height].join(","); };
  var w = document.createTreeWalker(document.documentElement), n = 0; while (w.nextNode()) n++;
  return { kids: document.body.childNodes.length, els: document.querySelectorAll("*").length, html: document.body.innerHTML.length, walk: n,
    a: r(document.getElementById("a")), b: r(document.getElementById("b")), z: r(document.getElementById("z")), body: r(document.body),
    hits: [document.elementFromPoint(5, 5).id, document.elementFromPoint(400, 10).id, document.elementFromPoint(200, 10).id, document.elementsFromPoint(400, 10).length],
    shadow: String(document.body.shadowRoot), slot: String(document.getElementById("a").assignedSlot), sheets: document.styleSheets.length,
    adopted: document.adoptedStyleSheets.length, scroll: document.documentElement.scrollHeight + "," + document.body.scrollHeight,
    last: document.body.lastChild.nodeName, active: document.activeElement === document.body, records: records };
}
</script>`;

describe.skipIf(!wanted)("the portal toolbar in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let port = 0;
    const portalReferers: (string | null)[] = [];

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const proxy = `http://127.0.0.1:${port}`;
            const u = req.url ?? "";
            if (u === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            if (u === "/portal") { portalReferers.push(req.headers.referer ?? null); return res.end("<!doctype html><title>portal</title>"); }
            if (!u.startsWith("/cyrano/")) return res.end(`<!doctype html><body>${PAGE}`);
            const page = `http://localhost:${port}/p/page`;
            const config = { apiBaseURL: proxy, source: "/rewriter.js", toolbar: { home: `${proxy}/portal` } };
            return res.end(`<!doctype html><script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,${JSON.stringify(config)}).inject();$rewriter.set_location(${JSON.stringify(page)});(function(s,p){p=s.previousElementSibling;if(p&&p.src&&p.tagName==="SCRIPT")p.remove();s.remove()})(document.currentScript);</script><body>${PAGE}`);
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

    const open = async (url: string): Promise<Page> => {
        const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
        await page.goto(url);
        await page.waitForFunction("typeof snap === 'function'");
        return page;
    };
    const snap = (page: Page): Promise<unknown> => page.evaluate(() => (window as unknown as { snap(): unknown }).snap());
    const seen = (page: Page): Promise<string[]> => page.evaluate(() => { const w = window as unknown as { seen: string[] }; const s = w.seen.slice(); w.seen.length = 0; return s; });

    it("the page reads as without it", async () => {
        const direct = await open(`http://localhost:${port}/p/page`);
        const proxied = await open(`http://127.0.0.1:${port}/cyrano/http/localhost:${port}/p/page`);
        const d = await snap(direct);
        expect(d).toMatchObject({ shadow: "null", slot: "null", records: 0, hits: ["a", "z", "b", 3] }); // (400, 10) is inside the toolbar's box
        expect(await snap(proxied)).toEqual(d);
        await direct.close();
        await proxied.close();
    }, 30_000);

    it("clicks on it are not the page's; the grip slides it, << and >> jump, home goes to the portal", async () => {
        const page = await open(`http://127.0.0.1:${port}/cyrano/http/localhost:${port}/p/page`);
        const y = TOOLBAR.height / 2;
        const start = initialLeft(800, TOOLBAR.width); // the middle of the top edge
        const HOME = TOOLBAR.grip + TOOLBAR.jump + 10, LEFT = TOOLBAR.grip + 10, RIGHT = TOOLBAR.width - 10;
        const clicks = async (): Promise<string[]> => (await seen(page)).filter((s) => s.startsWith("click:"));
        const cursor = (): Promise<string> => page.evaluate(() => getComputedStyle(document.getElementById("z")!).cursor);
        // Outside it: the page's own click, as ever.
        await page.mouse.click(300, 100);
        expect(await clicks()).toEqual(["click:HTML@300"]);
        // The cursor over it (it takes no pointer events: the host's cursor, inherited beneath).
        expect(await cursor()).toBe("auto");
        await page.mouse.move(start + 8, y);
        expect(await cursor()).toBe("grab");
        await page.mouse.move(start + HOME, y);
        expect(await cursor()).toBe("pointer");
        await page.mouse.move(start + 8, 80);
        expect(await cursor()).toBe("auto");
        // Slide it left by the grip, to 100: nothing reaches the page.
        await page.mouse.move(start + 8, y);
        await seen(page); // (moves over it are the page's: it takes no hover)
        await page.mouse.down();
        await page.mouse.move(108, y, { steps: 6 });
        await page.mouse.up();
        expect(await seen(page)).toEqual([]);
        // Where it was is the page's again.
        await page.mouse.click(start + HOME, y);
        expect(await clicks()).toEqual([`click:z@${start + HOME}`]);
        // ">>": to the right end; "<<": to the left end. Neither is the page's.
        await page.mouse.click(100 + RIGHT, y);
        expect(await clicks()).toEqual([]);
        await page.mouse.click(100 + RIGHT, y);
        expect(await clicks()).toEqual([`click:b@${100 + RIGHT}`]); // it is gone from there
        const right = rightEnd(800, TOOLBAR.width);
        await page.mouse.click(right + LEFT, y);
        expect(await clicks()).toEqual([]);
        await page.mouse.click(right + LEFT, y);
        expect((await clicks()).length).toBe(1); // at the left end now: this one was the page's
        await page.mouse.click(RIGHT, y); // ">>" again: remembered at the right end
        // Its place is remembered across a load — in a name the page's
        // storage does not list.
        await page.goto(`http://127.0.0.1:${port}/cyrano/http/localhost:${port}/p/page`);
        await page.waitForFunction("typeof snap === 'function'");
        expect(await page.evaluate(() => {
            const sc = document.createElement("script");
            sc.textContent = "window.__ls = [localStorage.length, Object.keys(localStorage).join(), localStorage.getItem('crn-toolbar-left')]";
            document.head.appendChild(sc);
            sc.remove();
            return (window as unknown as { __ls: unknown[] }).__ls;
        })).toEqual([0, "", null]);
        await page.mouse.click(start + HOME, y);
        expect(await clicks()).toEqual([`click:z@${start + HOME}`]);
        // The home button, where it is now: no event for the page, and off to the portal.
        await page.mouse.click(right + HOME, y);
        await page.waitForURL(/\/portal$/);
        expect(page.url()).toBe(`http://127.0.0.1:${port}/portal`);
        // Left as a user typing the portal's address: no Referer (with one,
        // the proxy would take the bare path for the page's own).
        expect(portalReferers).toEqual([null]);
        await page.close();
    }, 30_000);
});
