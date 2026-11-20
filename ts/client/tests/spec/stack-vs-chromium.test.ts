// @vitest-environment node
//
// spec/Stack.agda against V8: scripts at URLs with parentheses, colons,
// fragments, non-ASCII and spaces, on two origins and a blob:, each
// calling a probe through plain, oddly named, constructor, method, eval,
// nested eval, Function and async frames. The URLs `stackurls` reads off
// the default-formatted stack are the CallSites' file names (http(s),
// blob:, file:), an eval frame's being the script it was evaluated in.
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T | Promise<T>): Promise<T>; waitForFunction(f: () => unknown): Promise<unknown>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const CASE_SCRIPT = `(function () {
    const me = document.currentScript.src;
    const C = window.cases;
    C.push([me, "direct", function f() { return probe(); }]);
    const o = { ["a(b"]: function () { return probe(); }, ["x (y)"]: function () { return probe(); } };
    C.push([me, "odd names", () => o["a(b"]() || o["x (y)"]()]);
    C.push([me, "odd name 2", () => o["x (y)"]()]);
    class Foo { constructor() { this.r = probe(); } }
    C.push([me, "new", () => new Foo().r]);
    C.push([me, "method", () => ({ m() { return probe(); } }).m()]);
    // Sources unique per script: V8 reuses a Function's code compiled
    // before, and names the first script as its origin.
    const tag = JSON.stringify(me);
    C.push([me, "eval", () => eval("probe() //" + tag)]);
    C.push([me, "nested eval", () => eval("eval('probe()'); //" + tag)]);
    C.push([me, "Function", () => new Function("return probe() //" + tag)()]);
    C.push([me, "async", async () => { await null; return probe(); }]);
    C.push([me, "map", () => [1].map(function g() { return probe(); })[0]]);
})();`;

const MAIN = `window.cases = [];
Error.stackTraceLimit = 50;
window.probe = function probe() {
    const text = new Error().stack;
    const prev = Error.prepareStackTrace;
    Error.prepareStackTrace = (e, s) => s;
    const sites = new Error().stack;
    Error.prepareStackTrace = prev;
    return { text, sites: sites.map((x) => ({ file: x.getFileName() || null, isEval: x.isEval() })) };
};
const b = document.createElement("script");
b.src = URL.createObjectURL(new Blob([${JSON.stringify(CASE_SCRIPT)}], { type: "text/javascript" }));
document.head.appendChild(b);
addEventListener("load", async () => {
    const out = [];
    for (const [me, kind, run] of window.cases) out.push({ me, kind, ...(await run()) });
    window.results = out;
});`;

describe.skipIf(!wanted || located.skip !== "")("Stack URLs: the spec is V8", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u === "/") {
                res.setHeader("Content-Type", "text/html");
                const scripts = ["/s/a.js", "/s/a(b).js", "/s/a)b(c.js", "/s/q.js?x=1:2:3", "/s/f.js#f:1:2", "/s/é.js", "/s/sp ace.js", "/s/c,d;e.js", `http://127.0.0.1:${port}/s/other.js`];
                res.end(`<!doctype html><script src="/main.js"></script>${scripts.map((s) => `<script src="${s}"></script>`).join("")}`);
                return;
            }
            res.setHeader("Content-Type", "text/javascript");
            res.end(u === "/main.js" ? MAIN : CASE_SCRIPT);
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        oracle?.close();
        await browser?.close();
        server?.close();
    });

    it("the URLs read off a stack are V8's", async () => {
        const page = await browser.newPage();
        await page.goto(`http://localhost:${port}/`);
        await page.waitForFunction(() => (window as unknown as { results?: unknown }).results !== undefined);
        const rows = await page.evaluate(() => (window as unknown as { results: { me: string; kind: string; text: string; sites: { file: string | null; isEval: boolean }[] }[] }).results);
        await page.close();
        const ok = (f: string): boolean => /^(https?|blob|file):/.test(f);
        const bad: string[] = [];
        for (const r of rows) {
            // an eval frame: the script it ran in (a script URL has no fragment)
            const truth = r.sites.flatMap((s) => s.isEval ? [r.me.split("#")[0]!] : s.file !== null && ok(s.file) ? [s.file] : []);
            const got = (await oracle.ask("stackurls", [r.text]))!;
            if (got !== truth.join("\n")) bad.push(`${r.me} ${r.kind}:\n${r.text}\n  spec  ${JSON.stringify(got.split("\n"))}\n  V8    ${JSON.stringify(truth)}`);
        }
        expect(rows.length).toBeGreaterThan(80);
        expect(bad.slice(0, 4), String(bad.length)).toEqual([]);
    }, 120_000);
});
