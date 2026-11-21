// @vitest-environment node
//
// Every eval the source shows is rewritten, nothing else is touched
// (spec/Eval.agda), in real Chromium. A proxied page — its script
// rewritten as the server rewrites it — calls the intrinsic eval and a
// function that is not eval, in every shape the spec names, and records
// what happened: whether the code saw the caller's scope (direct or
// indirect), whether it was rewritten (it reads the page's original URL,
// not the proxy's), and for any other callee the very argument it got.
// Each record must be the oracle's `proxied` outcome.
//
// Needs the built bundle, the spec oracle and Playwright's Chromium:
// `make spec-check browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";
import { defaultJsRewriteOptions, rewriteJsSource } from "../../src/js/rewriter";
import { unmarked } from "../../src/js/marks";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; waitForFunction(f: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

// The source each call evaluates: what scope it sees, and which URL.
const SRC = "typeof __l + ' ' + location.href.slice(0, 19)";

// [callee, shape, arg, the call as page code writes it (inside a function with a local __l)]
const CASES: Array<[string, string, string, string]> = [
    ["intrinsic", "named", "text", "eval(SRC)"],
    ["intrinsic", "named", "text", "(eval)(SRC)"],
    ["intrinsic", "named", "text", "(function () { var eval = window.eval; return eval(SRC); })()"],
    ["intrinsic", "named", "text", "(function () { var eval = window['eval']; return eval(SRC); })()"],
    ["intrinsic", "seen", "text", "window.eval(SRC)"],
    ["intrinsic", "seen", "text", "window['eval'](SRC)"],
    ["intrinsic", "seen", "text", "eval.call(null, SRC)"],
    ["intrinsic", "seen", "text", "window.eval.apply(window, [SRC])"],
    ["intrinsic", "seen", "text", "(0, eval)(SRC)"],
    ["intrinsic", "renamed", "text", "(function () { var e = window.eval; return e(SRC); })()"],
    ["intrinsic", "named", "other", "eval(5)"],
    ["intrinsic", "seen", "other", "window.eval(5)"],
    ["notEval", "named", "text", "(function () { var eval = NOT; return eval(SRC); })()"],
    ["notEval", "seen", "text", "({ eval: NOT }).eval(SRC)"],
    ["notEval", "seen", "text", "(function () { var eval = NOT; return eval.call(null, SRC); })()"],
    ["notEval", "seen", "text", "(function () { var eval = NOT; return (0, eval)(SRC); })()"],
    ["notEval", "renamed", "text", "(function () { var e = NOT; return e(SRC); })()"],
];

const PAGE_SCRIPT = `
window.NOT = function (s) { return "passed " + (typeof s === "string" ? "text " + s : "other"); };
var SRC = ${JSON.stringify(SRC)};
window.got = [${CASES.map(([, , , call]) => `(function () { var __l = 1; try { return String(${call}); } catch (e) { return "throws " + e.message; } })()`).join(",\n")}];
`;

describe.skipIf(!wanted || located.skip !== "")("eval calls: the spec is Chromium, proxied", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let origin = "";

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        const bundle = readFileSync(bundlePath, "utf8");
        // The page's script as the server serves it: rewritten.
        const rewritten = rewriteJsSource(PAGE_SCRIPT, defaultJsRewriteOptions());
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u.startsWith("/rewriter.js")) {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            if (u.startsWith("/cyrano/https/site.example/page")) {
                const boot = `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/page");</script>`;
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(`<!doctype html><html><head>${boot}</head><body><script>${rewritten}</script></body></html>`);
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
        oracle?.close();
        await browser?.close();
        server?.close();
    });

    it("each call does what the spec's proxied outcome says", async () => {
        const page = await browser.newPage();
        await page.goto(`${origin}/cyrano/https/site.example/page`);
        await page.waitForFunction("window.got !== undefined");
        const got = await page.evaluate(() => (window as unknown as { got: string[] }).got);
        await page.close();
        const bad: string[] = [];
        for (let i = 0; i < CASES.length; i++) {
            const [callee, shape, arg, call] = CASES[i]!;
            const spec = (await oracle.ask("evalcall", [callee, shape, arg, SRC]))!;
            // The spec's outcome as the page observes it.
            let want: string;
            if (spec === "returned") want = "5";
            else if (spec.startsWith("passed text ")) want = "passed text " + SRC;
            else {
                const scope = spec.startsWith("direct ") ? "number" : "undefined";
                const rewrittenSrc = spec.includes("R(");
                want = scope + " " + (rewrittenSrc ? "https://site.examp" : origin.slice(0, 19)).slice(0, 19);
            }
            const seen = unmarked(got[i]!);
            if (seen.slice(0, want.length) !== want.slice(0, want.length) || seen.length < Math.min(want.length, 10)) bad.push(`${call}\n    spec ${spec} → ${want}\n    page ${seen}`);
        }
        expect(bad, bad.join("\n")).toEqual([]);
    }, 60_000);
});
