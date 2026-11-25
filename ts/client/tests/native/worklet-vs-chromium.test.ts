// @vitest-environment node
//
// Worklet modules, in real Chromium, direct and through the real proxy
// (round K: `Worklet.prototype.addModule` was not wrapped — an absolute
// URL loaded from its origin, outside the proxy; the page's own origin
// named absolutely failed, AbortError, as mixed content from the https
// proxy page; a relative one was resolved against the proxy). The runtime
// proxifies the module URL (and a blob: module's, rewritten); a worklet's
// code runs where there is no runtime, so the server rewrites a worklet
// module (Sec-Fetch-Dest audioworklet / paintworklet / sharedstorageworklet)
// with the rules that need none (spec/Disposition.agda workletDest:
// static import specifiers, import.meta.url). An audio worklet reports
// what its module read (its static import, a computed member, its own
// import.meta.url); a paint worklet's module is loaded. Playwright does not
// show worklet fetches: an escape is a request the upstream receives with
// the proxy's origin as Origin.
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
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

describe.skipIf(!wanted)("worklet modules, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let other = "";
    let proxyOrigin = "";
    const origins: string[] = [];
    // what each module request carried: path, Sec-Fetch-Dest, Origin
    const heads: string[] = [];

    // An audio worklet module: what it read, posted from its processor.
    const audio = (tag: string): string => `import { v } from "./dep.js";
        const o = { a: "member" }; const k = "a";
        registerProcessor("p-${tag}", class extends AudioWorkletProcessor {
            constructor() { super(); this.port.postMessage([v, o[k], typeof location, import.meta.url].join(" ")); }
            process() { return false; }
        });`;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = req.url ?? "/";
            if (req.headers.origin) origins.push(`${req.headers.origin} ${u}`);
            // (Not a blob: module's import: Chromium sends it with no
            // Referer, so the proxy cannot tell its document — a gap shared
            // with blob: module workers.)
            if (u !== "/page.html" && req.headers.referer) heads.push(`${u} ${req.headers["sec-fetch-dest"]} ${req.headers.origin ?? "-"}`);
            const js = { "content-type": "text/javascript", "access-control-allow-origin": "*" };
            if (u === "/page.html") {
                res.writeHead(200, { "content-type": "text/html" });
                return res.end(`<!doctype html><body><script>
                    window.out = {};
                    const load = async (name, url, tag) => {
                        try {
                            const ctx = new OfflineAudioContext(1, 128, 44100);
                            await ctx.audioWorklet.addModule(url);
                            const node = new AudioWorkletNode(ctx, "p-" + tag);
                            window.out[name] = await new Promise((r) => { node.port.onmessage = (e) => r(e.data); setTimeout(() => r("silent"), 3000); });
                        } catch (e) { window.out[name] = String(e && e.name) + ": " + String(e && e.message); }
                    };
                    const blob = URL.createObjectURL(new Blob([${JSON.stringify(audio("b").replace('"./dep.js"', '"OTHER/dep.js"'))}], { type: "text/javascript" }));
                    (async () => {
                        await load("other", "OTHER/aw.js?t=o", "o");
                        await load("own", location.origin + "/aw.js?t=s", "s");
                        await load("relative", "/aw.js?t=r", "r");
                        await load("blob", blob, "b");
                        window.out.paint = await CSS.paintWorklet.addModule("OTHER/pw.js").then(() => "ok", (e) => String(e && e.name));
                        window.out.done = true;
                    })();
                </script></body>`.replace(/OTHER/g, other));
            }
            if (u.startsWith("/aw.js")) {
                const tag = new URL(u, "http://x").searchParams.get("t") ?? "";
                res.writeHead(200, js);
                return res.end(audio(tag));
            }
            if (u === "/dep.js") {
                res.writeHead(200, js);
                return res.end(`export const v = "dep";`);
            }
            if (u === "/pw.js") {
                res.writeHead(200, js);
                return res.end(`import { v } from "./dep.js"; const o = { a: 1 }; const k = "a";
                    registerPaint("p", class { paint(c) { c.fillRect(0, 0, o[k], v.length); } });`);
            }
            res.writeHead(404);
            return res.end();
        });
        await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
        const port0 = (upstream.address() as { port: number }).port;
        self = `http://127.0.0.1:${port0}`;
        other = `http://localhost:${port0}`;
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
        browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    });
    afterAll(async () => {
        await browser?.close();
        proxy?.kill();
        upstream?.close();
    });

    const run = async (url: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(url);
        for (let i = 0; i < 80; i++) {
            if (await page.evaluate(() => (window as unknown as { out: { done?: boolean } }).out?.done)) break;
            await page.evaluate(() => new Promise((res) => setTimeout(res, 100)));
        }
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return out;
    };

    it("load through the proxy and read as directly", async () => {
        heads.length = 0;
        const direct = await run(`${self}/page.html`);
        const directHeads = [...heads].sort();
        origins.length = 0;
        heads.length = 0;
        const proxied = await run(`${proxyOrigin}/cyrano/http/${self.slice(7)}/page.html`);
        expect(direct).toEqual({
            other: `dep member undefined ${other}/aw.js?t=o`,
            own: `dep member undefined ${self}/aw.js?t=s`,
            relative: `dep member undefined ${self}/aw.js?t=r`,
            blob: "dep member undefined " + (direct as { blob: string }).blob.split(" ").pop(),
            paint: "ok",
            done: true,
        });
        expect((direct as { blob: string }).blob).toMatch(/ blob:http:\/\/127\.0\.0\.1:\d+\//);
        const { blob: pb, ...pr } = proxied as { blob: string };
        const { blob: db, ...dr } = direct as { blob: string };
        expect(pr).toEqual(dr);
        expect(pb.replace(/ blob:.*/, "")).toEqual(db.replace(/ blob:.*/, ""));
        // each request carried what it carries directly (a worklet's
        // module and imports: its document's Origin, even same-origin)
        expect([...heads].sort()).toEqual(directHeads);
        expect(directHeads).toContain(`/aw.js?t=s audioworklet ${self}`);
        // nothing reached the upstream from the browser itself
        expect(origins.filter((o) => o.startsWith(proxyOrigin))).toEqual([]);
    }, 90_000);
});
