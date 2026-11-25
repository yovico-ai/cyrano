// @vitest-environment node
//
// The old FileSystem API (webkitRequestFileSystem), in real Chromium,
// direct and through the real proxy, two sites in one browser (round K's
// built-in survey: through the proxy every site had the proxy origin's one
// file system — a file one site wrote, another listed). Each site has its
// own (spec/Storage.agda fsPath); what an entry reads — fullPath, name,
// toURL, its file system's name, the root's parent, ".." at the root, a
// refused removal of the root, a resolved URL — is as directly; a worker
// of the site sees the site's files.
//
// Runs the server binary (go/assets/cyrano: ./go/scripts/build.sh) on a
// free port. Needs it and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const binary = process.env.CYRANO_BINARY ?? resolve(root, "go/assets/cyrano");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(binary);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };

const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

// What a site does: write (site A) or only look (site B).
const SCRIPT = `
window.out = new Promise((done) => {
  const out = {};
  const writer = location.search === "?a";
  const e = (k, next) => [(v) => { out[k] = v && v.fullPath !== undefined ? [v.fullPath, v.name, v.isDirectory] : "ok"; next(); }, (x) => { out[k] = x.name + ": " + x.message; next(); }];
  webkitRequestFileSystem(TEMPORARY, 1024, (fs) => {
    const R = fs.root;
    out.fs = [fs.name.replace(/_\\d+:/, "_P:"), R.fullPath, R.name, R.toURL().replace(/:\\d+\\//, ":P/")];
    const steps = writer ? [
      (n) => R.getDirectory("d", { create: true }, (d) => d.getFile("a b.txt", { create: true }, (f) => { out.file = [f.fullPath, f.name, f.toURL().replace(/:\\d+\\//, ":P/"), f.filesystem === fs]; n(); }, ...e("fileErr", n).slice(1)), ...e("dirErr", n).slice(1)),
      (n) => R.getFile("../../top.txt", { create: true }, ...e("up", n)),
      (n) => R.getDirectory("d", {}, (d) => d.getFile("../../../top2.txt", { create: true }, ...e("upFromD", n)), ...e("noD", n).slice(1)),
      (n) => R.getParent(...e("rootParent", n)),
      (n) => R.getDirectory("d", {}, (d) => d.getParent(...e("dParent", n)), ...e("noD2", n).slice(1)),
      (n) => R.remove(...e("removeRoot", n)),
      (n) => R.removeRecursively(...e("removeRootRec", n)),
      (n) => R.getFile("", {}, ...e("empty", n)),
      (n) => webkitResolveLocalFileSystemURL(location.origin.replace(/^/, "filesystem:") + "/temporary/d/a%20b.txt", ...e("resolved", n)),
      (n) => webkitResolveLocalFileSystemURL(location.origin.replace(/^/, "filesystem:") + "/temporary/../../top.txt", ...e("resolvedUp", n)),
      (n) => webkitResolveLocalFileSystemURL("filesystem:http://elsewhere.example/temporary/x", ...e("resolvedOther", n)),
    ] : [];
    const list = (n) => R.createReader().readEntries((es) => { out.list = es.map((x) => x.fullPath).sort(); n(); }, ...e("listErr", n).slice(1));
    // a worker of the same site lists the same root
    const inWorker = (n) => {
      const src = "webkitRequestFileSystem(TEMPORARY, 1024, (fs) => fs.root.createReader().readEntries((es) => postMessage([fs.name.replace(/_\\d+:/, '_P:'), es.map((x) => x.fullPath).sort()]), (x) => postMessage(x.name)), (x) => postMessage(x.name));";
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
      w.onmessage = (m) => { out.worker = m.data; n(); };
      w.onerror = () => { out.worker = "error"; n(); };
    };
    const go = (i) => i < steps.length ? steps[i](() => go(i + 1)) : list(() => inWorker(() => done(out)));
    go(0);
  }, (x) => { out.err = x.name; done(out); });
});
`;

describe.skipIf(!wanted)("the old FileSystem API, in Chromium, per site through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let a = "";
    let b = "";
    let proxyOrigin = "";

    beforeAll(async () => {
        upstream = createServer((_req, res) => {
            res.writeHead(200, { "content-type": "text/html" });
            return res.end("<!doctype html><body><script>" + SCRIPT + "</script></body>");
        });
        await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
        const p0 = (upstream.address() as { port: number }).port;
        a = `http://127.0.0.1:${p0}`;
        b = `http://localhost:${p0}`;
        const port = await free();
        proxyOrigin = `http://localhost:${port}`;
        proxy = spawn(binary, ["--assets", resolve(root, "go/assets"), "--log-level", "warn"], {
            env: { ...process.env, CYRANO_PUBLIC_URL: proxyOrigin, CYRANO_PORT: String(port), CYRANO_HOSTNAME: "localhost", CYRANO_HTTPS_ENABLED: "false" },
            stdio: "ignore",
        });
        for (let i = 0; i < 100; i++) {
            try { if ((await fetch(proxyOrigin + "/")).ok) break; } catch { /* starting */ }
            await new Promise((r) => setTimeout(r, 100));
        }
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        await browser?.close();
        proxy?.kill();
        upstream?.close();
    });

    // Site A writes, then site B looks — in one browser context.
    const both = async (url: (site: string) => string): Promise<[unknown, unknown]> => {
        const ctx = await browser.newContext();
        const go = async (u: string): Promise<unknown> => {
            const page = await ctx.newPage();
            await page.goto(u);
            const out = await page.evaluate(() => (window as unknown as { out: Promise<unknown> }).out);
            await page.close();
            return out;
        };
        const ra = await go(url(a) + "?a");
        const rb = await go(url(b) + "?b");
        await ctx.close();
        return [ra, rb];
    };

    it("keeps each site's files its own, read as directly", async () => {
        const direct = await both((s) => `${s}/page.html`);
        const proxied = await both((s) => `${proxyOrigin}/cyrano/http/${s.slice(7)}/page.html`);
        expect((direct[1] as { list: string[] }).list).toEqual([]);
        expect((direct[0] as { list: string[] }).list).toEqual(["/d", "/top.txt", "/top2.txt"]);
        expect(proxied[0]).toEqual(direct[0]);
        expect(proxied[1]).toEqual(direct[1]);
    }, 90_000);
});
