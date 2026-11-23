// @vitest-environment node
//
// navigator.serviceWorker.getRegistration, in real Chromium, direct and
// proxied (staples.com, 2026-11-22: its own absolute URL was refused with a
// SecurityError naming the proxy's origin). Judged against the page's own
// origin: the same answers and errors as direct (origins in messages read
// as SELF).
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
  const out = {};
  const ask = async (k, ...a) => {
    try { out[k] = String(await navigator.serviceWorker.getRegistration(...a)); }
    catch (e) { out[k] = e.name + ": " + e.message.split(location.origin).join("SELF"); }
  };
  await ask("own", location.origin + "/x");
  await ask("relative", "/");
  await ask("none");
  await ask("other", "https://other.example/");
  out.registrations = (await navigator.serviceWorker.getRegistrations()).length;
  window.out = out;
})();
`;

describe.skipIf(!wanted)("navigator.serviceWorker.getRegistration, in Chromium", () => {
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
            if (u === "/direct" || u.startsWith("/cyrano/https/site.example/page")) {
                const boot = u === "/direct" ? "" : `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/page");</script>`;
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                // The page's code as the server sends it: rewritten (here by the runtime, the same rules).
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
        await page.evaluate(() => new Promise((res) => setTimeout(res, 500)));
        const out = await page.evaluate(() => (window as unknown as { out: unknown }).out);
        await page.close();
        return out;
    };

    it("answers as direct", async () => {
        const direct = await run("/direct");
        const proxied = await run("/cyrano/https/site.example/page");
        expect(direct).toMatchObject({ own: "undefined", relative: "undefined", none: "undefined" });
        expect(proxied).toEqual(direct);
    });
});
