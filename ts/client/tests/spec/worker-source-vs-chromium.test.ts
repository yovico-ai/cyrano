// @vitest-environment node
//
// spec/WorkerSource.agda against Chromium: Workers and SharedWorkers, classic
// and module, from blob: URLs of Blobs of many types and from data: URLs of
// those types, run (the script posts a message) exactly when `workerruns`
// says, given the Blob's type or the data: URL's MIME type as Chromium
// reports it.
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T | Promise<T>, a: A): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

// The conformance test's types, and a Blob without one.
const TYPES = [null, "", "text/plain", "application/json", "text/javascript", "TEXT/JavaScript", "application/x-javascript", "text/jscript", "text/javascript1.5",
    "text/javascript; charset=utf-8", "application/ecmascript", "text/x-ecmascript", "image/png", "text/html", "foo", "text/livescript", "application/javascriptx",
    " text/javascript", "text/javascript ;x=y", "text/javascript1.6", "module", "javascript", "text/x-javascript", "application/javascript\t"];

describe.skipIf(!wanted || located.skip !== "")("blob:/data: workers: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html>x"); });
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

    it("a worker runs as the spec says", async () => {
        const page = await browser.newPage();
        await page.goto(`http://localhost:${port}/`);
        const rows = await page.evaluate(async (types: (string | null)[]) => {
            const run = (url: string, module: boolean, shared: boolean): Promise<string> => new Promise((r) => {
                try {
                    const opts = module ? { type: "module" as const } : {};
                    const t = setTimeout(() => r("silent"), 1500);
                    if (shared) {
                        const w = new SharedWorker(url, opts);
                        w.port.onmessage = () => { clearTimeout(t); r("ran"); };
                        w.onerror = () => { clearTimeout(t); r("error"); };
                    } else {
                        const w = new Worker(url, opts);
                        w.onmessage = () => { clearTimeout(t); r("ran"); };
                        w.onerror = () => { clearTimeout(t); r("error"); };
                    }
                } catch (e) { r(`throw ${(e as Error).name}`); }
            });
            const out: { source: string; mime: string; module: boolean; shared: boolean; got: string }[] = [];
            let n = 0;
            for (const t of types) {
                for (const shared of [false, true]) {
                    // A shared worker of the same URL is reused: each its own script.
                    const code = (k: number) => shared ? `/*${k}*/onconnect=(e)=>e.ports[0].postMessage(1)` : `/*${k}*/postMessage(1)`;
                    for (const module of [false, true]) {
                        const blob = t === null ? new Blob([code(++n)]) : new Blob([code(n = n + 1)], { type: t });
                        out.push({ source: "blob", mime: blob.type, module, shared, got: await run(URL.createObjectURL(blob), module, shared) });
                        const d = `data:${t ?? ""},${encodeURIComponent(code(++n))}`;
                        const mime = (await fetch(d)).headers.get("content-type") ?? "";
                        out.push({ source: `data ${JSON.stringify(t)}`, mime, module, shared, got: await run(d, module, shared) });
                    }
                }
            }
            return out;
        }, TYPES);
        await page.close();
        const bad: string[] = [];
        let failed = 0;
        for (const r of rows) {
            const want = (await oracle.ask("workerruns", [r.module ? "1" : "0", r.mime])) === "yes" ? "ran" : "error";
            if (r.got === "error") failed++;
            if (r.got !== want) bad.push(`${r.shared ? "SharedWorker" : "Worker"} ${r.module ? "module" : "classic"} ${r.source} (${JSON.stringify(r.mime)}): Chromium ${r.got}, spec ${want}`);
        }
        expect(bad, String(bad.length)).toEqual([]);
        expect(failed).toBeGreaterThan(10);
    }, 180_000);
});
