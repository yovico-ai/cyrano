// @vitest-environment node
//
// Another origin's windows reached by number and by window.open, in real
// Chromium, direct and through the real proxy (round I: frames[0] of a
// cross-origin child was its real Window — the page read its document and
// cookies, and frames[0] !== iframe.contentWindow; a popup opened on another
// origin's URL stayed readable). frames[n] / window[n] / top.frames[n] are
// rewritten to the runtime's view (R18); window.open(url) is judged by
// url's origin while the popup is still on about:blank. Checked from the
// page's own script, as directly.
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

describe.skipIf(!wanted)("cross-origin windows by number and window.open, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            const other = `http://localhost:${port0}`;
            if (u.pathname === "/page") {
                res.writeHead(200, { "content-type": "text/html" });
                return res.end(`<!doctype html><iframe id=x src="${other}/child"></iframe><iframe id=s src="/child"></iframe><script>
                    window.out = new Promise((done) => addEventListener("load", () => setTimeout(async () => {
                        const o = {};
                        const x = document.getElementById("x"), s = document.getElementById("s");
                        o.same0 = frames[0] === x.contentWindow;
                        o.same1 = frames[1] === s.contentWindow && window[1] === s.contentWindow;
                        o.tag = Object.prototype.toString.call(frames[0]);
                        try { o.doc = typeof frames[0].document; } catch (e) { o.doc = e.name; }
                        try { o.doc2 = typeof top.frames[0].document; } catch (e) { o.doc2 = e.name; }
                        o.len = frames[0].length;
                        // its own properties as Chromium describes them (HTML CrossOriginGetOwnPropertyHelper)
                        const w0 = frames[0];
                        const d = (ob, k) => { try { const x = Object.getOwnPropertyDescriptor(ob, k); if (!x) return "none"; return ["value" in x ? "v:" + typeof x.value : "", "get" in x ? "g:" + typeof x.get : "", "set" in x ? "s:" + typeof x.set : "", x.enumerable ? "E" : "", x.configurable ? "C" : "", "writable" in x ? (x.writable ? "W" : "w") : ""].join(""); } catch (e) { return e.name; } };
                        const fx = (f) => { try { return [f.name, f.length, Function.prototype.toString.call(f)].join("|"); } catch (e) { return e.name; } };
                        o.desc = ["window", "self", "location", "closed", "frames", "length", "top", "opener", "parent", "blur", "close", "focus", "postMessage", "then", "zz"].map((k) => k + "=" + d(w0, k));
                        o.keys = Reflect.ownKeys(w0).map(String);
                        const gd = (k) => Object.getOwnPropertyDescriptor(w0, k);
                        o.fns = [fx(gd("window").get), fx(gd("location").get), fx(gd("location").set), fx(w0.close), fx(w0.postMessage), fx(Object.getOwnPropertyDescriptor(w0.location, "href").set), fx(w0.location.replace)];
                        o.stable = [gd("top").get === gd("top").get, gd("top").get === gd("parent").get, gd("window").get.call(w0) === w0, gd("length").get.call(w0)];
                        try { o.idx0 = String(w0[0]); } catch (e) { o.idx0 = e.name; }
                        try { o.idx0b = String(w0["0"]); } catch (e) { o.idx0b = e.name; }
                        try { gd("length").get.call({}); o.illegal = "none"; } catch (e) { o.illegal = e.constructor.name + ": " + e.message; }
                        const w = window.open("${other}/child", "pop");
                        await new Promise((r) => setTimeout(r, 800));
                        try { o.pop = typeof w.document; } catch (e) { o.pop = e.name; }
                        try { o.popHref = w.location.href; } catch (e) { o.popHref = e.name; }
                        o.popClosed = w.closed;
                        w.close();
                        done(o);
                    }, 300)));
                </script>`);
            }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end("<p>child");
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

    const run = async (url: string): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(url);
        const out = await page.evaluate(() => (window as unknown as { out: Promise<unknown> }).out);
        await page.close();
        return out;
    };

    it("is a cross-origin window there, as directly", async () => {
        const direct = await run(`http://127.0.0.1:${port0}/page`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page`);
        expect(direct).toMatchObject({ same0: true, same1: true, tag: "[object Object]", doc: "SecurityError", doc2: "SecurityError", len: 0, pop: "SecurityError", popHref: "SecurityError", popClosed: false });
        expect((direct as { fns: string[] }).fns[0]).toBe("get window|0|function get window() { [native code] }");
        expect(proxied).toEqual(direct);
    }, 60_000);
});
