// @vitest-environment node
//
// A page that replaces built-ins, in real Chromium (rugerforum.net's
// Ad-Shield does, for its integrity checks). The replacements are page code,
// so rewritten: their own computed accesses set `$__crn_key__`. The page's
// R5 accesses, in the form the rewriters emit, must still read the key the
// page wrote, and the runtime must call none of the replaced built-ins
// (native/intrinsics.ts) — a call would be both a tell and a clobbered key.
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

// The page: boots the runtime, then hooks the built-ins the runtime must
// not use, then runs R5 accesses written as the rewriter writes them.
const PAGE = (boot: string) => `<!doctype html><head>${boot}</head><body><iframe></iframe><script>
(function () {
    var hits = [], on = false, A = Reflect.apply, push = Array.prototype.push;
    function hook(o, k, label) {
        var f = o[k];
        if (typeof f !== "function") return;
        o[k] = function () {
            if (on) { on = false; A(push, hits, [label]); window.$__crn_key__ = "clobbered"; on = true; }
            return A(f, this, arguments);
        };
    }
    ["get", "set", "has", "delete"].forEach(function (k) { hook(WeakMap.prototype, k, "WeakMap#" + k); hook(Map.prototype, k, "Map#" + k); });
    ["add", "has", "delete"].forEach(function (k) { hook(WeakSet.prototype, k, "WeakSet#" + k); hook(Set.prototype, k, "Set#" + k); });
    ["call", "apply", "bind"].forEach(function (k) { hook(Function.prototype, k, "Function#" + k); });
    ["apply", "construct", "get", "set", "has", "ownKeys", "getOwnPropertyDescriptor", "defineProperty", "getPrototypeOf"].forEach(function (k) { hook(Reflect, k, "Reflect." + k); });
    ["defineProperty", "getOwnPropertyDescriptor", "getPrototypeOf", "create", "keys", "freeze"].forEach(function (k) { hook(Object, k, "Object." + k); });
    hook(Object.prototype, "hasOwnProperty", "Object#hasOwnProperty");
    hook(window, "queueMicrotask", "queueMicrotask");
    window.runChecks = function () {
        var out = {};
        on = true;
        try {
            // window["Array"]["from"] — Ad-Shield's integrity walk.
            out.arrayFrom = $rewriter.wrap_member_expression($rewriter.wrap_member_expression(window, $__crn_key__ = ("Array"))[$__crn_key__], $__crn_key__ = ("from"))[$__crn_key__] === Array.from;
            out.localStorageGetItem = typeof $rewriter.wrap_member_expression($rewriter.wrap_member_expression(window, $__crn_key__ = ("localStorage"))[$__crn_key__], $__crn_key__ = ("getItem"))[$__crn_key__];
            out.top = $rewriter.wrap_member_expression(window, $__crn_key__ = ("top"))[$__crn_key__] === window;
            out.parent = $rewriter.wrap_member_expression(window, $__crn_key__ = ("parent"))[$__crn_key__] === window;
            out.locationHref = $rewriter.wrap_member_expression($rewriter.wrap_member_expression(window, $__crn_key__ = ("location"))[$__crn_key__], $__crn_key__ = ("href"))[$__crn_key__];
            out.frame0 = $rewriter.wrap_member_expression(window, $__crn_key__ = (0))[$__crn_key__] === document.querySelector("iframe").contentWindow;
            out.docWriteIsFn = typeof $rewriter.wrap_member_expression(document, $__crn_key__ = ("write"))[$__crn_key__];
            out.postMessageIsFn = typeof $rewriter.wrap_member_expression(window, $__crn_key__ = ("postMessage"))[$__crn_key__];
            var plain = { location: function () { return this; } };
            out.plainLocationThis = $rewriter.wrap_member_expression(plain, $__crn_key__ = ("location"))[$__crn_key__]() === plain;
        } catch (e) {
            out.error = String(e);
        }
        on = false;
        out.hits = hits.slice();
        return out;
    };
})();
</script></body>`;

describe.skipIf(!wanted)("a page that replaces built-ins, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        const boot = (original: string) =>
            `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(original)});</script>`;
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                res.end(bundle);
                return;
            }
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(PAGE(boot("https://site.example/page")));
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        const addr = server.address();
        origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        const require = createRequire(resolve(__dirname, "../../../e2e/package.json"));
        const { chromium } = require("playwright") as { chromium: { launch(o: object): Promise<Browser> } };
        browser = await chromium.launch({ headless: true });
    }, 60_000);

    afterAll(async () => {
        await browser?.close();
        await new Promise<void>((r) => server?.close(() => r()));
    });

    it("reads the keys the page wrote, and calls none of the replaced built-ins", async () => {
        const page = await browser.newPage();
        await page.goto(`${origin}/cyrano/https/site.example/page`);
        const out = await page.evaluate(() => (window as unknown as { runChecks(): Record<string, unknown> }).runChecks());
        expect(out).toEqual({
            arrayFrom: true,
            localStorageGetItem: "function",
            top: true,
            parent: true,
            locationHref: "https://site.example/page",
            frame0: true,
            docWriteIsFn: "function",
            postMessageIsFn: "function",
            plainLocationThis: true,
            hits: [],
        });
    }, 60_000);

    // mountaineers.org (Plone): its bundle makes startsWith a RegExp —
    // "[" throws in it — and the runtime's cookie setter called it: every
    // cookie write threw, and GA and the Facebook pixel never set theirs.
    it("cookies work under a page's RegExp startsWith polyfill", async () => {
        const page = await browser.newPage();
        await page.goto(`${origin}/cyrano/https/site.example/page`);
        const out = await page.evaluate(() => {
            const sp = String.prototype as unknown as Record<string, unknown>;
            const own = sp["startsWith"];
            sp["startsWith"] = function (this: string, s: string) { return !!this.match(new RegExp("^" + s)); };
            sp["endsWith"] = function (this: string, s: string) { return !!this.match(new RegExp(s + "$")); };
            try {
                document.cookie = "_ga=GA1.2.1; path=/; domain=site.example";
                document.cookie = "t=1; path=/";
                return document.cookie.split("; ").sort().join("; ");
            } catch (e) {
                return "threw " + (e as Error).message + " " + String((e as Error).stack).split("\n").slice(1, 6).join(" | ");
            } finally {
                sp["startsWith"] = own;
            }
        });
        expect(out).toBe("_ga=GA1.2.1; t=1");
    }, 60_000);
});
