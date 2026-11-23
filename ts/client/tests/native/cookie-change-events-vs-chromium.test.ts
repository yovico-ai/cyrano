// @vitest-environment node
//
// cookieStore's change events, in real Chromium, direct and proxied. The
// runtime keeps the page's cookies in memory (cookies/memory.ts), so the
// browser's own store's events list the channel: they are stopped, and the
// page's are made from memory's changes — one per write to a cookie shown
// at the page's URL (even of the same value), in a later task, its items as
// Chromium makes them (a deleted one without value and expires; sameSite
// only when stated). One the page dispatches itself goes through. Not
// compared: isTrusted (a made event is not); an expiry's microseconds (the
// runtime's clock is performance.now's, coarsened).
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const SCRIPT = `
(async () => {
const log = [];
cookieStore.addEventListener("change", (e) => log.push([e.changed.map((c) => JSON.stringify({ ...c, expires: c.expires === null ? null : "set" })),
    e.deleted.map((c) => JSON.stringify(c))]));
let early = 0; cookieStore.onchange = () => { early++; };
const tick = () => new Promise((r) => setTimeout(r, 150));
// (Chromium subscribes the listener asynchronously: a write at once may come first.)
await tick(); await tick();
document.cookie = "a=1; path=/"; const sync = early; await tick();
document.cookie = "a=2; path=/; max-age=3600"; await tick();
document.cookie = "a=2; path=/; max-age=3600"; await tick();
document.cookie = "a=; path=/; max-age=0"; await tick();
await cookieStore.set("b", "x"); await tick();
await cookieStore.set({ name: "e", value: "1", expires: 1900000000000 }); await tick();
await cookieStore.delete("b"); await tick();
document.cookie = "c=1; path=/elsewhere"; await tick();
cookieStore.dispatchEvent(new CookieChangeEvent("change", { changed: [{ name: "mine", value: "1" }] })); await tick();
window.out = { sync, log };
})();
`;

describe.skipIf(!wanted)("cookieStore change events, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u.startsWith("/rewriter.js")) {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            if (u.startsWith("/a/direct") || u.startsWith("/cyrano/https/site.example/a/page")) {
                const boot = u.startsWith("/a/direct") ? "" : `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/a/page");</script>`;
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(`<!doctype html><html><head>${boot}</head><body><script>const s = document.createElement("script"); s.text = ${JSON.stringify(SCRIPT).replace(/</g, "\\u003c")}; document.body.appendChild(s);</script></body></html>`);
            }
            res.writeHead(404);
            return res.end();
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const run = async (path: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(origin + path);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 2500)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return out;
    };

    it("come as directly", async () => {
        const direct = await run("/a/direct");
        const proxied = await run("/cyrano/https/site.example/a/page");
        expect((direct as { log: unknown[] }).log.length).toBe(8);
        expect(proxied).toEqual(direct);
    });
});
