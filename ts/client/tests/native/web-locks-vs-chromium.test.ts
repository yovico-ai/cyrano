// @vitest-environment node
//
// Web Locks per original origin (spec/Storage.agda lockName), in real
// Chromium, direct and proxied (round H: every proxied site shares the
// proxy origin's one lock manager — a lock one site held kept another's of
// the same name waiting, and query() listed it; Supabase, Firebase,
// Workbox and Dexie use fixed lock names). Now: site A holds "L"; site B
// gets "L" at once and lists none of A's; A's Lock reads its own name;
// a name starting with "-" gets the native's error. The Origin Private File
// System likewise (round H: a file one site made was listed and read by
// every other site): A's file is A's, B's root is empty, a root's name is "".
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T | Promise<T>, a: A): Promise<T>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };


describe.skipIf(!wanted)("Web Locks and the OPFS, each site its own, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u.startsWith("/rewriter.js")) {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            const m = /^\/cyrano\/https\/([a-z]+\.example)\/page/.exec(u);
            const boot = m ? `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://${m[1]}/page");</script>` : "";
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return res.end(`<!doctype html><html><head>${boot}</head><body>page</body></html>`);
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const run = async (a: string, b: string): Promise<unknown> => {
        const ctx = await browser.newContext();
        const pa = await ctx.newPage(); await pa.goto(a);
        const pb = await ctx.newPage(); await pb.goto(b);
        const heldA = await pa.evaluate(() => new Promise<unknown>((res) => {
            void navigator.locks.request("L", (l) => new Promise<void>((done) => {
                void navigator.locks.query().then((q) => res({ name: l?.name, held: (q.held ?? []).map((x) => x.name) }));
                (window as unknown as { release: () => void }).release = done;
            }));
        }), null);
        const fromB = await pb.evaluate(async () => {
            const got = await navigator.locks.request("L", { ifAvailable: true }, (l) => l && l.name);
            const q = await navigator.locks.query();
            let dash = "";
            try { await navigator.locks.request("-x", () => 1); } catch (e) { dash = (e as Error).name + ": " + (e as Error).message; }
            return { got, held: (q.held ?? []).map((x) => x.name), dash };
        }, null);
        await pa.evaluate(() => (window as unknown as { release: () => void }).release(), null);
        await ctx.close();
        return { heldA, fromB };
    };

    it("keeps each site's locks its own, as direct", async () => {
        const direct = await run(`http://127.0.0.1:${port}/a`, `http://localhost:${port}/b`);
        const proxied = await run(`http://127.0.0.1:${port}/cyrano/https/a.example/page`, `http://127.0.0.1:${port}/cyrano/https/b.example/page`);
        expect(direct).toEqual({ heldA: { name: "L", held: ["L"] }, fromB: { got: "L", held: [], dash: "NotSupportedError: Failed to execute 'request' on 'LockManager': Names cannot start with '-'." } });
        expect(proxied).toEqual(direct);
    }, 60_000);

    const opfs = async (a: string, b: string): Promise<unknown> => {
        const ctx = await browser.newContext();
        const pa = await ctx.newPage(); await pa.goto(a);
        const fromA = await pa.evaluate(async () => {
            const root = await navigator.storage.getDirectory();
            const f = await root.getFileHandle("siteA-file", { create: true });
            const w = await f.createWritable(); await w.write("A"); await w.close();
            const names: string[] = [];
            for await (const k of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(k);
            const again = await navigator.storage.getDirectory();
            return { name: root.name, kind: root.kind, names, same: await again.isSameEntry(root), path: await root.resolve(f) };
        }, null);
        const pb = await ctx.newPage(); await pb.goto(b);
        const fromB = await pb.evaluate(async () => {
            const root = await navigator.storage.getDirectory();
            const names: string[] = [];
            for await (const k of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(k);
            return { name: root.name, names };
        }, null);
        await ctx.close();
        return { fromA, fromB };
    };

    it("keeps each site's private file system its own, as direct", async () => {
        const direct = await opfs(`http://127.0.0.1:${port}/a`, `http://localhost:${port}/b`);
        const proxied = await opfs(`http://127.0.0.1:${port}/cyrano/https/a.example/page`, `http://127.0.0.1:${port}/cyrano/https/b.example/page`);
        expect(direct).toEqual({ fromA: { name: "", kind: "directory", names: ["siteA-file"], same: true, path: ["siteA-file"] }, fromB: { name: "", names: [] } });
        expect(proxied).toEqual(direct);
    }, 60_000);
});
