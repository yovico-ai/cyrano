// @vitest-environment node
//
// javascript: URLs, in real Chromium, direct and through the real proxy: a
// string result became the frame's new document unrewritten, its images and
// scripts going to their origins. Now the URL's code goes through the JS
// rules (spec/JsUrl.agda; server markup, the runtime's setters, location,
// window.open alike): its result document is rewritten with the bootstrap,
// every request goes through the proxy, and the page reads its URLs back as
// it wrote them.
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

describe.skipIf(!wanted)("javascript: URL documents, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    let got: string[] = [];
    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            const k = u.searchParams.get("k");
            if (k) { got.push(k); res.writeHead(200, { "content-type": "image/gif", "access-control-allow-origin": "*" }); return res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")); }
            const b = `http://localhost:${port0}`;
            // The document a javascript: URL's string makes: an image and a script.
            const doc = (n: string): string => `<img src="${b}/i.gif?k=${n}img"><script>new Image().src = "${b}/i.gif?k=${n}js"; parent.postMessage("${n}", "*");</script>`;
            const js = (n: string): string => "javascript:" + JSON.stringify(doc(n)).replace(/'/g, "\\'").replace(/^"|"$/g, "'").replace(/\\"/g, '"');
            const lit = (v: unknown): string => JSON.stringify(v).replace(/<\//g, "<\\/");
            const attr = (v: string): string => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><script>window.out = []; addEventListener("message", (e) => out.push(String(e.data)));</script>
<iframe src="${attr(js("static"))}"></iframe>
<iframe src="${attr("javascript:'%3Cimg src=" + b + "/i.gif?k=pctimg%3E%3Cscript%3Eparent.postMessage(%22pct%22,%22*%22)%3C/script%3E'")}"></iframe>
<a id="v" href="javascript:void(0)">v</a><a id="w" href="${attr(js("link"))}">w</a>
<iframe name="loc"></iframe>
<script>
const J = ${lit({ set: js("set"), attr: js("attr"), loc: js("loc"), link: js("link") })};
const f = document.createElement("iframe"); f.src = J.set; document.body.append(f);
const g = document.createElement("iframe"); g.setAttribute("src", J.attr); document.body.append(g);
onload = () => { frames.loc.location = J.loc; };
window.reads = { v: v.href, w: w.getAttribute("href") === J.link, wHref: w.href, set: f.src, setAttr: g.getAttribute("src") === J.attr };
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

    const run = async (proxied: boolean): Promise<{ out: string[]; got: string[]; escaped: string[]; reads: unknown }> => {
        const url = proxied ? `${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page` : `http://127.0.0.1:${port0}/page`;
        got = [];
        const p = await browser.newPage();
        const escaped: string[] = [];
        p.on("request", (r) => { const x = r.url(); if (proxied && /^https?:/.test(x) && !x.startsWith(proxyOrigin)) escaped.push(x); });
        await p.goto(url);
        await p.evaluate(() => new Promise((res) => setTimeout(res, 2000)));
        const out = await p.evaluate(() => (window as unknown as { out: string[] }).out);
        const reads = await p.evaluate(() => (window as unknown as { reads: unknown }).reads);
        await p.close();
        return { out: [...out].sort(), got: [...new Set(got)].sort(), escaped, reads };
    };

    it("make documents that load through the proxy, and read as written", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        const names = ["attr", "loc", "set", "static"];
        expect(direct.out).toEqual([...names, "pct"].sort());
        expect(direct.got).toEqual([...names.flatMap((n) => [n + "img", n + "js"]), "pctimg"].sort());
        expect(direct.reads).toMatchObject({ v: "javascript:void(0)", w: true, setAttr: true });
        expect(proxied.out).toEqual(direct.out);
        expect(proxied.got).toEqual(direct.got);
        expect(proxied.reads).toEqual(direct.reads);
        expect(proxied.escaped).toEqual([]);
    }, 60_000);
});
