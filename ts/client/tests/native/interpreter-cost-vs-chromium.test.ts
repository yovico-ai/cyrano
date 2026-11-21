// @vitest-environment node
//
// What costs nothing natively must cost little rewritten — distilled from
// Cloudflare's Turnstile on techcrunch.com (2026-11-20), where the page
// froze. In real Chromium, the same script direct and proxied (rewritten
// as the server does):
//
//  - a bytecode interpreter: a dispatch loop that makes a computed access
//    per operation, with the kinds of key Turnstile's has (a XOR of
//    constants, an index that is incremented, an identifier holding a
//    number or a string such as "length"). Rewritten,
//    it ran three times slower; it must stay within a small factor.
//  - a timing probe: an eval of 1.3 MB of spaces around a few tokens,
//    again and again with a new tail. Natively the whitespace is skipped;
//    through the parser each one took 80 ms.
//
// Both give the same results as direct. The bounds are loose (machines
// and tiers vary); what they catch is the order of magnitude.
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

type Page = { goto(u: string): Promise<unknown>; waitForFunction(f: string, a?: unknown, o?: { timeout: number }): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };
type Got = { vm: number; sum: number; probe: number; probes: number[] };

// The interpreter's dispatch function is very large (thousands of distinct
// handlers inline), as an obfuscated VM's is: V8 does not optimize a
// function that size, so every operation runs in the baseline tiers —
// where a call per computed access is what it costs.
const CASES = 2500;
const handler = (i: number): string => {
    const k = 1141213000 + i;
    switch (i % 5) {
        // (Keys held in variables, as Turnstile's are: "length", "push", one letter.)
        case 0: return `case ${i}: st[(a ^ ${k} ^ C) & 15] = (st[a & 15] + b + m[n] + m[L]) | 0; break;`;
        case 1: return `case ${i}: st[b & 15] ^= m[(pc ^ ${k}) & 255] + st[sp] + reg[one]; sp = (sp + 1) & 15; qq[P](b); if (qq[L] > 64) qq[L] = 0; break;`;
        case 2: return `case ${i}: n = tab[${k} ^ C]; st[a & 15] = m[n] + m[b] | 0; break;`;
        case 3: return `case ${i}: t = st[sp]; st[sp] = st[a & 15] >>> (b & 7); st[(sp + 1) & 15] = t; break;`;
        default: return `case ${i}: st[0] = (st[0] + m[a] + m[st[b & 15] & 255]) | 0; n = (n + 1) & 255; break;`;
    }
};
const JS = `
var C = 0x4405be5f;
var code = [], N = 40000;
for (var i = 0; i < N; i++) code.push((i * 7919) % ${CASES}, (i * 31) & 255, (i * 17) & 255);
var m = []; for (var i = 0; i < 256; i++) m[i] = (i * 2654435761) | 0;
var L = ["len", "gth"].join(""), P = ["pu", "sh"].join(""), one = String.fromCharCode(104), reg = { h: 7 }, qq = [];
var tab = {}; for (var i = 0; i < ${CASES}; i++) tab[(1141213000 + i) ^ C] = i & 255;
function run(rounds) {
  var st = [], pc, op, a, b, t, n = 0, sp = 0;
  for (var j = 0; j < 16; j++) st[j] = j;
  for (var r = 0; r < rounds; r++) {
    pc = 0;
    while (pc < code.length) {
      op = code[pc++]; a = code[pc++]; b = code[pc++];
      switch (op) {
${Array.from({ length: CASES }, (_x, i) => handler(i)).join("\n")}
      }
    }
  }
  var s = 0; for (var q = 0; q < 16; q++) s = (s * 31 + st[q]) | 0;
  return s;
}
run(1);
var t0 = performance.now(); var sum = run(20); var vm = performance.now() - t0;
var pad = new Array(1337332).join(" "), probes = [], v = 0;
for (var p = 0; p < 5; p++) { var t1 = performance.now(); v += eval(pad + "0, /.*honk.*/, " + (1795223596708 + p)) % 1000; probes.push(performance.now() - t1); }
window.got = { vm: vm, sum: sum, probe: v, probes: probes };
`;

describe.skipIf(!wanted)("an interpreter and a timing probe in Chromium, direct and proxied", () => {
    let browser: Browser;
    let server: Server;
    let port = 0;

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
            if (!u.startsWith("/cyrano/")) return res.end(`<!doctype html><script>${JS}</script>`);
            const page = `http://localhost:${port}/p/page`;
            return res.end(`<!doctype html><script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(proxy)},source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(page)});</script><script>${rewriteJsSource(JS, defaultJsRewriteOptions())}</script>`);
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

    const run = async (url: string): Promise<Got> => {
        const page = await browser.newPage();
        await page.goto(url);
        await page.waitForFunction("window.got !== undefined", null, { timeout: 120_000 });
        const got = await page.evaluate(() => (window as unknown as { got: Got }).got);
        await page.close();
        return got;
    };
    // The better of three: one slow run (a busy machine) is not the cost.
    // A probe's cost is its slowest evaluation in a run (the first pays for a cold parser).
    const best = async (url: string): Promise<Got> => {
        const runs = [await run(url), await run(url), await run(url)];
        return { ...runs[0]!, vm: Math.min(...runs.map((r) => r.vm)), probes: runs.map((r) => Math.max(...r.probes)) };
    };

    it("the interpreter stays within a small factor of direct, and the probe is not parsed", async () => {
        const direct = await best(`http://localhost:${port}/p/page`);
        const proxied = await best(`http://127.0.0.1:${port}/cyrano/http/localhost:${port}/p/page`);
        expect({ sum: proxied.sum, probe: proxied.probe }).toEqual({ sum: direct.sum, probe: direct.probe });
        console.log(`interpreter: direct ${direct.vm.toFixed(0)} ms, proxied ${proxied.vm.toFixed(0)} ms; probe eval: direct ${Math.min(...direct.probes).toFixed(1)} ms, proxied ${Math.min(...proxied.probes).toFixed(1)} ms`);
        // Measured 2026-11-20: 1.4 times direct (2.0 with R5 on numeric keys);
        // the probe 2.4 ms as direct (24 ms through the parser).
        expect(proxied.vm).toBeLessThan(direct.vm * 1.7 + 20);
        expect(Math.min(...proxied.probes)).toBeLessThan(Math.min(...direct.probes) + 10);
    }, 300_000);
});
