// @vitest-environment node
//
// spec/Referrer.agda setsPolicy against Chromium: a response served with
// Referrer-Policy: origin sets the policy of what it creates — its own
// requests then carry an origin-only Referer — exactly when its request's
// destination is one the spec names (`setspolicy`, by the Sec-Fetch-Dest
// Chromium sent). Documents in frames, objects and embeds, dedicated,
// module, shared and service workers, a script, a stylesheet.
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { goto(u: string): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const KINDS = ["iframe", "object", "embed", "worker", "module", "shared", "service", "script", "style"];

describe.skipIf(!wanted || located.skip !== "")("Which responses set a referrer policy: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;
    const dest = new Map<string, string>();     // kind → Sec-Fetch-Dest of the creating request
    const referer = new Map<string, string>();  // kind → Referer of its own request

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            const k = u.searchParams.get("k") ?? "";
            const own = (kind: string): string => `/own?k=${kind}&q=1`;
            if (u.pathname === "/own") { referer.set(k, String(req.headers.referer ?? "-")); res.end("x"); return; }
            if (u.pathname === "/p") {
                res.setHeader("Content-Type", "text/html");
                res.end(`<!doctype html><iframe src="/c?k=iframe"></iframe><object data="/c?k=object" type="text/html"></object><embed src="/c?k=embed" type="text/html">
                    <script src="/c?k=script"></script><link rel=stylesheet href="/c?k=style">
                    <script>new Worker("/c?k=worker"); new Worker("/c?k=module", {type: "module"}); new SharedWorker("/c?k=shared");
                    navigator.serviceWorker.register("/c?k=service");</script>`);
                return;
            }
            dest.set(k, String(req.headers["sec-fetch-dest"] ?? ""));
            res.setHeader("Referrer-Policy", "origin");
            if (k === "iframe" || k === "object" || k === "embed") {
                res.setHeader("Content-Type", "text/html");
                res.end(`<!doctype html><script>fetch("${own(k)}")</script>`);
            } else if (k === "style") {
                res.setHeader("Content-Type", "text/css");
                res.end(`body { background: url("${own(k)}") }`);
            } else {
                res.setHeader("Content-Type", "text/javascript");
                res.end(`fetch("${own(k)}")`);
            }
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

    it("an origin-only Referer exactly where the spec says the response sets the policy", async () => {
        const page = await browser.newPage();
        await page.goto(`http://localhost:${port}/p`);
        await page.waitForTimeout(2000);
        await page.close();
        const bad: string[] = [];
        for (const k of KINDS) {
            const d = dest.get(k);
            const r = referer.get(k);
            if (d === undefined || r === undefined) { bad.push(`${k}: no request (dest ${d}, referer ${r})`); continue; }
            const originOnly = r === `http://localhost:${port}/`;
            const want = (await oracle.ask("setspolicy", [d])) === "yes";
            if (originOnly !== want) bad.push(`${k} (dest ${d}): Referer ${r}, spec ${want ? "sets" : "does not set"} the policy`);
        }
        expect(bad, bad.join("\n")).toEqual([]);
    }, 120_000);
});
