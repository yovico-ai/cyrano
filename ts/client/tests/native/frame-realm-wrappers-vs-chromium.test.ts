// @vitest-environment node
//
// A frame's nodes and events are of the frame's realm, in real Chromium,
// direct and through the real proxy. Chromium keeps one wrapper per node
// (and per event) and makes it in the realm of the callback that first
// receives it: a MutationObserver callback or event listener of the
// creator's copy of the runtime, on a frame's document, gave the frame's
// parsed nodes the creator's prototypes — `el instanceof HTMLDivElement` was
// false in the frame's own scripts. Instagram's embed checks just that
// (invariant #63112 in PolarisEmbedSimple: blog.libro.fm showed 5 of its 9
// embeds) since a frame on its way to a proxied URL runs its creator's
// runtime (adoptDocument). The runtime's callbacks on another window are
// made that window's (native/realm-callback.ts).
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const binary = process.env.CYRANO_BINARY ?? resolve(root, "go/assets/cyrano");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(binary);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; waitForFunction(f: () => unknown, a?: unknown, o?: object): Promise<unknown>; on(e: string, f: (x: Error) => void): void };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };

const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

// One 1×1 GIF.
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

describe.skipIf(!wanted)("a frame's nodes and events are its own realm's, in Chromium", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/i.gif") {
                res.writeHead(200, { "content-type": "image/gif" });
                return res.end(gif);
            }
            if (u.pathname === "/slow") {
                // The frame's own document, late (the frame runs its creator's
                // runtime meanwhile): its parsed nodes, an image's load event.
                setTimeout(() => {
                    res.writeHead(200, { "content-type": "text/html" });
                    res.end(`<!doctype html><div class=Embed>x</div><img id=i src="/i.gif"><script>
                        const r = parent.__slow = { div: document.querySelector(".Embed") instanceof HTMLDivElement };
                        document.getElementById("i").addEventListener("load", (e) => {
                            r.event = e instanceof Event;
                            r.target = e.target instanceof HTMLImageElement;
                        });
                        addEventListener("load", () => { r.done = true; });
                    </script>`);
                }, 800);
                return;
            }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><body><script>
                const f = document.createElement("iframe");
                f.src = "/slow";
                document.body.appendChild(f);
                // An empty frame written into: its parser makes the nodes.
                const g = document.createElement("iframe");
                document.body.appendChild(g);
                const d = g.contentDocument;
                d.open();
                d.write('<div class=w>w</div><script>parent.__written = document.querySelector(".w") instanceof HTMLDivElement<\\/script>');
                d.close();
            </script>`);
        });
        await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
        port0 = (upstream.address() as { port: number }).port;
        const port = await free();
        proxyOrigin = `http://localhost:${port}`;
        proxy = spawn(binary, ["--assets", process.env.CYRANO_ASSETS ?? resolve(root, "go/assets"), "--log-level", "warn"], {
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

    type Seen = { slow: { div: boolean; event?: boolean; target?: boolean }; written: boolean };
    const run = async (proxied: boolean): Promise<{ seen: Seen; errors: string[] }> => {
        const url = proxied ? `${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page` : `http://127.0.0.1:${port0}/page`;
        const ctx = await browser.newContext();
        const p = await ctx.newPage();
        const errors: string[] = [];
        p.on("pageerror", (e) => errors.push(String(e.message)));
        await p.goto(url);
        await p.waitForFunction(() => (window as unknown as { __slow?: { done?: boolean } }).__slow?.done, undefined, { timeout: 15_000 });
        const seen = await p.evaluate(() => ({ slow: (window as unknown as { __slow: Seen["slow"] }).__slow, written: (window as unknown as { __written: boolean }).__written }));
        await ctx.close();
        return { seen, errors };
    };

    it("its parsed and written nodes, and its events, are instances of its own interfaces", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        expect(direct.seen).toEqual({ slow: { div: true, event: true, target: true, done: true }, written: true });
        expect(proxied.errors).toEqual([]);
        expect(proxied.seen).toEqual(direct.seen);
    }, 60_000);
});
