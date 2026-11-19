// @vitest-environment node
//
// Workers built from Blobs, in real Chromium: the worker gets the runtime
// (classic: importScripts; module: the init-module import), its own
// fetch() is proxified, and the page's Blob is left exactly as made.
//
// The test server plays the Go server's part: /rewriter.js, the module
// init (server.WorkerInitPath), and recording what the workers request.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T | Promise<T>): Promise<T> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

describe.skipIf(!wanted)("workers in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";
    const seen: string[] = [];
    const referers: Record<string, string> = {};

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        const config = (o: string) => JSON.stringify({ apiBaseURL: o, source: "/rewriter.js" });
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            const o = `http://${req.headers.host}`;
            if (u === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            if (u.startsWith("/cyrano-worker-init.js")) {
                const href = new URL(u, o).searchParams.get("u") ?? "";
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(`import "${o}/rewriter.js";\nself.$rewriter=self.$rewriter_init_worker(${config(o)},${JSON.stringify(href)});self.$__crn_key__=null;\n`);
            }
            if (u.startsWith("/cyrano/https/tiles.example/")) {
                referers[u.split("?")[0]!] = req.headers.referer ?? "-";
                res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
                return res.end("ok");
            }
            if (u.startsWith("/cyrano/https/example.com/from-")) {
                seen.push(u);
                res.writeHead(200, { "content-type": "text/plain" });
                return res.end("ok");
            }
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return res.end(`<!doctype html><head><script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,${config(o)}).inject();$rewriter.set_location("https://example.com/p/");</script></head><body></body>`);
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

    it("classic and module Blob workers get the runtime and proxify their own fetch", async () => {
        const page = await browser.newPage();
        await page.goto(`${origin}/cyrano/https/example.com/p/`);
        const result = await page.evaluate(async () => {
            const run = (kind: "classic" | "module") => new Promise<unknown>((done) => {
                const src = `fetch("/from-${kind}").then(() => postMessage([typeof $rewriter, location.href]), (e) => postMessage(["fetch failed " + e]));`;
                const blob = new Blob([src], { type: "text/javascript" });
                const w = new Worker(URL.createObjectURL(blob), kind === "module" ? { type: "module" } : {});
                w.onmessage = (e) => done(e.data);
                w.onerror = (e) => done(["worker error " + (e as ErrorEvent).message + " @" + (e as ErrorEvent).filename + ":" + (e as ErrorEvent).lineno]);
                setTimeout(() => done(["timeout"]), 5000);
            });
            const blob = new Blob(["abc"], { type: "text/javascript" });
            return { classic: await run("classic"), module: await run("module"), pageBlob: [blob.size, await blob.text()] };
        });
        expect(result.pageBlob).toEqual([3, "abc"]);
        expect(result.classic).toEqual(["object", "https://example.com/p/"]);
        expect(result.module).toEqual(["object", "https://example.com/p/"]);
        expect(seen.sort()).toEqual(["/cyrano/https/example.com/from-classic", "/cyrano/https/example.com/from-module"]);
    }, 60_000);

    // Mapbox: a worker's fetch names its page as referrer. Directly the
    // browser sends it (the policy applied); through the proxy the runtime
    // must hand it over proxified, or the browser drops it as cross-origin
    // and the proxy has no page to send (spec/Referrer.agda initReferrer).
    it("a worker's fetch keeps the referrer it names; Request.referrer reads it back", async () => {
        const page = await browser.newPage();
        await page.goto(`${origin}/cyrano/https/example.com/p/`);
        const result = await page.evaluate(async () => {
            const src = `
                const r = new Request("https://tiles.example/t1", { referrer: "https://example.com/p/page" });
                const reads = [r.referrer, new Request("/x", { referrer: "" }).referrer, new Request("/x", { referrer: "https://other.example/" }).referrer,
                    new Request("/x", { referrer: "/rel" }).referrer];
                fetch(r).then(() => fetch("https://tiles.example/t2", { referrer: "https://example.com/p/" }))
                    .then(() => fetch("https://tiles.example/t3", { referrer: "https://other.example/" }))
                    .then(() => postMessage(reads), (e) => postMessage(["fetch failed " + e]));`;
            const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
            return await new Promise<unknown>((done) => { w.onmessage = (e) => done(e.data); setTimeout(() => done(["timeout"]), 5000); });
        });
        // As directly: the URL, "", the context's own (cross-origin), the page's origin + /rel.
        expect(result).toEqual(["https://example.com/p/page", "", "about:client", "https://example.com/rel"]);
        // The proxy gets the page it names, proxified (and reads it back);
        // a cross-origin one is the context's own: a blob worker's, none.
        expect(referers).toEqual({
            "/cyrano/https/tiles.example/t1": `${origin}/cyrano/https/example.com/p/page`,
            "/cyrano/https/tiles.example/t2": `${origin}/cyrano/https/example.com/p/`,
            "/cyrano/https/tiles.example/t3": "-",
        });
    }, 60_000);
});
