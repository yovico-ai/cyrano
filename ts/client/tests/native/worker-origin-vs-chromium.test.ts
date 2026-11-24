// @vitest-environment node
//
// A worker's origin and resource timing, in real Chromium, direct and
// through the real proxy (round H: `self.origin` read the proxy's in every
// worker, where directly it is the worker's — the page's for a URL or blob:
// worker, "null" for a data: one; a worker's resource entries listed the
// runtime and named proxified URLs; its errors read every line one more
// than directly — the preamble is the script's first line — and the page's
// worker.onerror named the proxified URL, a blob: worker's the runtime's
// private copy). A blob: URL carries the proxy's origin (a known gap): any
// blob URL reads as BLOB here.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const binary = process.env.CYRANO_BINARY ?? resolve(root, "go/assets/cyrano");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(binary);

type Req = { url(): string };
type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };



const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

describe.skipIf(!wanted)("a worker\u2019s origin and resource timing, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            const js = { "content-type": "text/javascript" };
            if (u.pathname === "/dir/dep.js") { res.writeHead(200, js); return res.end("self.dep = 1;"); }
            if (u.pathname === "/dir/ck") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
            if (u.pathname === "/dir/w.js") {
                res.writeHead(200, js);
                return res.end(`importScripts("dep.js"); fetch("ck").then((r) => r.text()).then(() => {
                    const rel = (s) => String(s).split(location.origin).join("O");
                    postMessage({ origin: rel(self.origin), loc: rel(location.origin), names: performance.getEntriesByType("resource").map((e) => rel(e.name)).sort() });
                });`);
            }
            const ERR = 'try { null.x; } catch (e) { postMessage(String(e.stack).split("\\n")[1].trim().split(location.origin).join("O")); }\n//\n//\nsetTimeout(() => { throw new Error("boom"); }, 10);';
            if (u.pathname === "/dir/err.js") { res.writeHead(200, js); return res.end(ERR); }
            if (u.pathname === "/errpage") {
                res.writeHead(200, { "content-type": "text/html" });
                return res.end(`<!doctype html><script>
window.out = {};
const rel = (s) => String(s).split(location.origin).join("O");
const watch = (k, w) => { w.onmessage = (e) => { out[k + "Stack"] = e.data.replace(/blob:O\\/[0-9a-f-]+/, "BLOB"); }; w.onerror = (e) => { out[k + "Error"] = e.message + " | " + rel(e.filename).replace(/blob:[^/]+\\/\\/[^/]+\\/[0-9a-f-]+/, "BLOB").replace(/blob:O\\/[0-9a-f-]+/, "BLOB") + " | " + e.lineno; e.preventDefault(); }; };
watch("url", new Worker("/dir/err.js"));
watch("blob", new Worker(URL.createObjectURL(new Blob([${JSON.stringify(ERR)}], { type: "text/javascript" }))));
</script>`);
            }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><script>
window.out = {};
const rel = (s) => String(s).split(location.origin).join("O");
new Worker("/dir/w.js").onmessage = (e) => { out.url = e.data; };
const src = "postMessage({ origin: self.origin, loc: location.origin })";
new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" }))).onmessage = (e) => { out.blob = { origin: rel(e.data.origin), loc: rel(e.data.loc) }; };
new Worker("data:text/javascript," + encodeURIComponent(src)).onmessage = (e) => { out.data = { origin: rel(e.data.origin), loc: rel(e.data.loc) }; };
</script>`);
        });
        await new Promise<void>((r) => upstream.listen(0, "0.0.0.0", () => r()));
        port0 = (upstream.address() as { port: number }).port;
        self = `http://127.0.0.1:${port0}`;
        void self;
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

    const run = async (proxied: boolean, path = "/page"): Promise<unknown> => {
        const url = proxied ? `${proxyOrigin}/cyrano/http/127.0.0.1:${port0}${path}` : `http://127.0.0.1:${port0}${path}`;
        const p = await browser.newPage();
        await p.goto(url);
        await p.evaluate(() => new Promise((res) => setTimeout(res, 2000)));
        const out = await p.evaluate(() => (window as unknown as { out: unknown }).out);
        await p.close();
        return out;
    };

    it("are the worker's own, as directly", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        expect(direct).toEqual({
            url: { origin: "O", loc: "O", names: ["O/dir/ck", "O/dir/dep.js"] },
            blob: { origin: "O", loc: "O" },
            data: { origin: "null", loc: "null" },
        });
        expect(proxied).toEqual(direct);
    }, 60_000);

    it("a worker's errors name its lines and URL, as directly", async () => {
        const direct = await run(false, "/errpage");
        const proxied = await run(true, "/errpage");
        expect(direct).toEqual({
            urlStack: "at O/dir/err.js:1:12", urlError: "Uncaught Error: boom | O/dir/err.js | 4",
            blobStack: "at BLOB:1:12", blobError: "Uncaught Error: boom | BLOB | 4",
        });
        expect(proxied).toEqual(direct);
    }, 60_000);
});
