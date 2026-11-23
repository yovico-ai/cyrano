// @vitest-environment node
//
// An error's stack, its first line, in real Chromium, direct and proxied:
// V8 writes the name the error has when its stack is first read and the
// message it was made with — a message changed before the first read, or a
// getter put on it, does not show (measured 2026-11-23). The runtime's
// formatter read the message as it was then. Errors V8 throws itself are
// left out (their message, changed before the first read, still shows
// proxied: the runtime never sees them made).
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
const head = (e) => String(e.stack).split("\\n")[0];
const out = [];
let e = new Error("a"); e.message = "b"; out.push(head(e));
e = new Error("a"); void e.stack; e.message = "b"; out.push(head(e));
e = new Error("a"); e.name = "X"; out.push(head(e));
e = new Error("a"); Object.defineProperty(e, "message", { get() { return "g"; } }); out.push(head(e));
class M extends Error { constructor() { super("m"); this.name = "MyErr"; } } e = new M(); e.message = "changed"; out.push(head(e));
e = Error("called"); e.message = "c2"; out.push(head(e));
e = new Error(); e.message = "late"; out.push(head(e));
e = new Error("a"); e.name = ""; out.push(head(e));
e = {}; Error.captureStackTrace(e); e.message = "q"; out.push(head(e));
window.out = out;
`;

describe.skipIf(!wanted)("the first line of an error stack, in Chromium", () => {
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
        await page.evaluate(() => new Promise((res) => setTimeout(res, 300)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return out;
    };

    it("is V8's, as direct", async () => {
        const direct = await run("/a/direct");
        const proxied = await run("/cyrano/https/site.example/a/page");
        expect(direct).toEqual(["Error: a", "Error: a", "X: a", "Error: a", "MyErr: m", "Error: called", "Error", "a", "Error: q"]);
        expect(proxied).toEqual(direct);
    });
});
