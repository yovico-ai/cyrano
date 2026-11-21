// @vitest-environment node
//
// Code compiled by a sandbox that shadows the global, in real Chromium,
// direct and proxied. Salesforce's Lightning Locker compiles component
// code with `globalThis` (and window) shadowed; the runtime's preamble for
// compiled code read `globalThis.$rewriter` and threw "Cannot read
// properties of undefined (reading '$rewriter')" — help.twitch.tv's
// knowledge pages rendered Aura's error box (2026-11-21).
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

// Component code as a sandbox would get it: a computed member read (R5) and
// location (R1), so the rewriter edits it and adds its preamble.
const SCRIPT = `
const body = 'var o = {a: 1, b: 2}, k = "b"; return [o[k], typeof location, String(location.href).slice(0, 8)].join(" ");';
const out = {};
const run = (name, f) => { try { out[name] = f(); } catch (e) { out[name] = "throws " + e.constructor.name + ": " + e.message; } };
run("globalThis undefined", () => Function("globalThis", "window", body)(undefined, undefined));
run("globalThis undefined, strict", () => Function("globalThis", "window", '"use strict";' + body)(undefined, undefined));
const fake = new Proxy({}, { get: (t, k) => (k === "location" ? { href: "https://site.example/page" } : undefined), has: () => true });
run("globalThis a proxy window", () => Function("globalThis", "window", body)(fake, fake));
run("with a sandbox", () => Function("sb", "with (sb) { return (function () {" + body + "})(); }")(new Proxy({}, { has: (t, k) => k === "globalThis", get: () => undefined })));
run("indirect eval", () => (0, eval)("(function (globalThis) {" + body + "})")(undefined));
// eval read off the window and called by the name eval: natively a direct
// eval (the callee is the intrinsic), so it sees the caller's scope.
// (Compiled with Function, which the runtime rewrites, as the server
// rewrites a page's scripts: window.eval is then the runtime's to hand out.)
run("window.eval called as eval", () => Function('const captured = window.eval; return (function () { var x = "local"; var eval = captured; return eval("typeof x"); })();')());
run("window['eval'] called as eval", () => Function('const captured = window["eval"]; return (function () { var x = "local"; var eval = captured; return eval("typeof x"); })();')());
run("an object's eval read in a with", () => Function('var o = {eval: window.eval}; return (function () { var x = "local"; with (o) { return eval("typeof x"); } })();')());
// Salesforce's Locker evaluator: compiled with the realm's Function; its
// with object claims every name the sandbox or the window has, and the
// code is direct-eval'd, strict, inside it.
const shell = Function("with (arguments[0]) { return function () { 'use strict'; return eval(arguments[0]); }; }");
const sandbox = new Proxy({ Object, Array, String }, {
    has: (t, k) => k === "eval" || (k !== "arguments" && (k in t || k in window)),
    get: (t, k) => (k === "eval" ? eval : k === Symbol.unscopables ? undefined : t[k]),
});
const evaluator = shell(sandbox);
// Its lockdown tames the Function constructor reached from a function: it
// builds nothing (so Function("return this") gives no global).
const ctorDesc = Object.getOwnPropertyDescriptor(Function.prototype, "constructor");
Object.defineProperty(Function.prototype, "constructor", { value: function () { return function () {}; }, writable: true, configurable: true });
run("locker evaluator", () => evaluator.call(sandbox, "(function () { var o = {a: 1, b: 2}, k = 'b'; return [o[k], typeof location].join(' '); })()"));
run("locker evaluator, a with inside", () => evaluator.call(sandbox, "(function () { var o = {a: 1, b: 2}, k = 'a', r; with ({z: 1}) { r = o[k] + z; } return String(r); })()"));
Object.defineProperty(Function.prototype, "constructor", ctorDesc);
window.got = out;
`;

describe.skipIf(!wanted)("code compiled with the global shadowed, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            const boot = u.startsWith("/cyrano/") ? `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/page");</script>` : "";
            if (u === "/page" || u.startsWith("/cyrano/https/site.example/page")) {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(`<!doctype html><html><head>${boot}</head><body><script>${SCRIPT}</script></body></html>`);
            }
            res.writeHead(204);
            return res.end();
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

    const run = async (path: string): Promise<Record<string, string>> => {
        const page = await browser.newPage();
        await page.goto(origin + path);
        const got = await page.evaluate(() => (window as unknown as { got: Record<string, string> }).got);
        await page.close();
        return got;
    };

    it("runs as direct", async () => {
        const direct = await run("/page");
        const proxied = await run("/cyrano/https/site.example/page");
        expect(direct["globalThis undefined"]).toMatch(/^2 object /);
        // location.href differs by design between the two servers' pages; the rest must not
        const shape = (o: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.replace(/ http:\/\/1$| https:\/\/$/, "")]));
        expect(shape(proxied)).toEqual(shape(direct));
    });
});
