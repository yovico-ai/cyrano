// @vitest-environment node
//
// spec/Csp.agda noScriptsRun against Chromium: under random CSP headers
// (one or two policies, script-src / -elem / -attr / default-src with
// 'none', nothing, or sources), a page's inline script, external script
// and inline event handler all fail to run exactly when `cspnoscripts`
// says no script runs — the documents that get no runtime — for one
// policy; for two, where the spec is sound but not complete, nothing runs
// wherever it says so.
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";
const seed = Number(process.env.CYRANO_SEED ?? Date.now() % 1e9);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; waitForTimeout(ms: number): Promise<void>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const NAMES = ["script-src", "script-src-elem", "script-src-attr", "default-src", "img-src", "Script-Src", "sandbox", "Sandbox"];
// A probe for each kind of source: an inline script, a nonced one, a
// hashed one (HASHED's hash), same-origin and cross-host external
// scripts, and an inline handler (HANDLER's hash for 'unsafe-hashes').
const HASHED = "document.documentElement.dataset.hashed = 1";
const HANDLER = "document.documentElement.dataset.attr = 1";
const sha = (s: string): string => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;
const VALUES = ["'none'", "", "'self'", "'unsafe-inline'", "'none' 'self'", "'NONE'", "*", "'self' 'unsafe-inline'", "'unsafe-eval'", "'report-sample' 'none'",
    "'unsafe-inline' 'nonce-abc'", "'unsafe-inline' 'strict-dynamic'", `'unsafe-hashes' ${sha(HANDLER)}`, `'unsafe-inline' ${sha(HASHED)}`, "http://other.example:PORT",
    "'strict-dynamic' 'nonce-abc'", `'strict-dynamic' ${sha(HASHED)}`, "'nonce-abc'"];
// A sandbox's own tokens (without allow-scripts nothing runs).
const SANDBOX = ["", "allow-scripts", "ALLOW-SCRIPTS allow-forms", "allow-same-origin", "allow-scripts allow-same-origin", "'none'"];

describe.skipIf(!wanted || located.skip !== "")("Documents where no script runs: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;
    const policies = new Map<string, string[]>();

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/s.js") { res.setHeader("Content-Type", "text/javascript"); res.end("document.documentElement.dataset.ext = 1"); return; }
            res.setHeader("Content-Type", "text/html");
            for (const p of policies.get(u.searchParams.get("k") ?? "") ?? []) res.appendHeader("Content-Security-Policy", p.replace(/PORT/g, String(port)));
            res.end(`<!doctype html><script>document.documentElement.dataset.inline = 1</script><script nonce="abc">document.documentElement.dataset.nonced = 1</script>
<script>${HASHED}</script><script src="/s.js"></script><script src="http://other.example:${port}/s.js"></script>
<script>${HANDLER}</script><img src="/nope.png" onerror="${HANDLER}"><img src="/nope2.png" onerror="${HASHED}">`);
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o: object): Promise<Browser> } };
        browser = await chromium.launch({ args: [`--host-resolver-rules=MAP other.example 127.0.0.1`] });
    });
    afterAll(async () => {
        oracle?.close();
        await browser?.close();
        server?.close();
    });

    it("nothing runs exactly when the spec says so", async () => {
        const directive = fc.constantFrom(...NAMES).chain((n) => fc.constantFrom(...(/^sandbox$/i.test(n) ? SANDBOX : VALUES)).map((v) => `${n} ${v}`.trim()));
        const policy = fc.array(directive, { minLength: 1, maxLength: 3 }).map((ds) => ds.join("; "));
        const draws = fc.sample(fc.array(policy, { minLength: 1, maxLength: 2 }), { numRuns: 60, seed });
        const bad: string[] = [];
        let none = 0;
        const page = await browser.newPage();
        for (let k = 0; k < draws.length; k++) {
            policies.set(String(k), draws[k]!);
            await page.goto(`http://localhost:${port}/?k=${k}`);
            await page.waitForTimeout(150);
            const ran = await page.evaluate(() => Object.keys(document.documentElement.dataset).length > 0);
            const want = (await oracle.ask("cspnoscripts", [draws[k]!.join("\n").replace(/PORT/g, String(port))])) === "yes";
            if (want) none++;
            if (ran === want && (draws[k]!.length === 1 || want)) bad.push(`${JSON.stringify(draws[k])}: Chromium ${ran ? "ran a script" : "ran none"}, spec ${want ? "none" : "some"}`);
        }
        await page.close();
        expect(bad.slice(0, 10), `${bad.length} (seed ${seed})`).toEqual([]);
        expect(none).toBeGreaterThan(3);
    }, 120_000);
});
