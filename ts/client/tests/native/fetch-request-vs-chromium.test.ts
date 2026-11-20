// @vitest-environment node
//
// fetch(request) goes where the Request really points, in real Chromium,
// direct and proxied: the browser fetches a Request's own URL, whatever a
// page's subclass says its `url` is. YouTube checks for blockers with a
// data: Request whose `url` names its player API; the runtime read that
// `url`, fetched the API instead, and rebuilt the request with a stream
// body HTTP/1.1 could not send (ERR_ALPN_NEGOTIATION_FAILED, 2026-11-20).
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);

type Page = { goto(u: string): Promise<unknown>; waitForFunction(f: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const PROBE = `<script>
class Faked extends Request { get url() { return location.origin + "/api/player"; } }
var fake = new Faked("data:application/json,%7B%22bait%22%3Atrue%7D", { method: "POST", body: "{}" });
var real = new Request("/api/real", { method: "POST", body: "{}" });
Promise.all([
  fetch(fake).then(function (r) { return r.text(); }, function (e) { return "rejects " + e.name; }),
  fetch(real).then(function (r) { return r.text(); }, function (e) { return "rejects " + e.name; }),
]).then(function (r) { window.got = { fake: r[0], real: r[1], fakeUrl: fake.url.replace(location.origin, "") }; });
</script>`;

describe.skipIf(!wanted)("fetch(request) in Chromium, direct and proxied", () => {
    let browser: Browser;
    let server: Server;
    let port = 0;
    const apiHits: string[] = [];

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const proxy = `http://127.0.0.1:${port}`;
            const u = req.url ?? "";
            if (u === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            if (u.includes("/api/")) {
                apiHits.push(u);
                res.writeHead(200, { "content-type": "text/plain" });
                return res.end(u.includes("real") ? "real" : "player");
            }
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            if (!u.startsWith("/cyrano/")) return res.end(`<!doctype html>${PROBE}`);
            const page = `http://localhost:${port}/p/page`;
            return res.end(`<!doctype html><script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(proxy)},source:"/rewriter.js"}).inject();$rewriter.set_location(${JSON.stringify(page)});</script>${PROBE}`);
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch({ args: ["--host-resolver-rules=MAP localhost 127.0.0.1"] });
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    const run = async (url: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(url);
        await page.waitForFunction("window.got !== undefined");
        const got = await page.evaluate(() => (window as unknown as { got: unknown }).got);
        await page.close();
        return got;
    };

    it("the Request's own URL", async () => {
        const direct = await run(`http://localhost:${port}/p/page`);
        expect(direct).toEqual({ fake: '{"bait":true}', real: "real", fakeUrl: "/api/player" });
        expect(apiHits.filter((h) => h.includes("player"))).toEqual([]);
        const proxied = await run(`http://127.0.0.1:${port}/cyrano/http/localhost:${port}/p/page`);
        expect(proxied).toEqual(direct);
        expect(apiHits.filter((h) => h.includes("player"))).toEqual([]);
    }, 30_000);
});
