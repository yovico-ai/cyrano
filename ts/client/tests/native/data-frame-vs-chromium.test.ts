// @vitest-environment node
//
// A frame given a data: URL of a document, in real Chromium, direct and
// through the real proxy (round I: its markup was unrewritten and it had
// no runtime — its images and fetches went to their origins). Now its
// document is rewritten as a srcdoc is, in a data: URL again (spec
// Frames.dataDocument, dataDocKind — an SVG one as XML; server markup and the
// runtime's setters alike): every
// request goes through the proxy, and the frame reads its own origin
// ("null") and its data: URL as directly.
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

describe.skipIf(!wanted)("frames given data: documents, in Chromium, through the proxy", () => {
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
            const svg = (n: string): string => `<svg xmlns="http://www.w3.org/2000/svg"><image href="${b}/i.gif?k=${n}img" width="1" height="1"/><script><![CDATA[fetch("${b}/f?k=${n}fetch"); parent.postMessage({ n: "${n}", origin: String(self.origin), loc: location.href.slice(0, 24) }, "*");]]></script></svg>`;
            const doc = (n: string): string => `<img src="${b}/i.gif?k=${n}img"><script>fetch("${b}/f?k=${n}fetch"); parent.postMessage({ n: "${n}", origin: String(self.origin), loc: location.href.slice(0, 24) }, "*");</script>`;
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><script>window.out = []; addEventListener("message", (e) => out.push(e.data.n + " " + e.data.origin + " " + e.data.loc));</script>
<iframe src="data:text/html,${encodeURIComponent(doc("static"))}"></iframe>
<iframe src="data:text/html;base64,${Buffer.from(doc("b64")).toString("base64")}"></iframe>
<object data="data:text/html,${encodeURIComponent(doc("object"))}"></object>
<iframe src="data:image/svg+xml,${encodeURIComponent(svg("svg"))}"></iframe>
<embed type="image/svg+xml" src="data:image/svg+xml,${encodeURIComponent(svg("svgembed"))}">
<script>
const f = document.createElement("iframe"); f.src = "data:text/html," + encodeURIComponent(${JSON.stringify(doc("setter")).replace(/<\//g, "<\\/")}); document.body.append(f);
const g = document.createElement("iframe"); g.setAttribute("src", "data:text/html," + encodeURIComponent(${JSON.stringify(doc("attr")).replace(/<\//g, "<\\/")})); document.body.append(g);
const h = document.createElement("iframe"); h.src = "data:image/svg+xml," + encodeURIComponent(${JSON.stringify(svg("svgset")).replace(/<\//g, "<\\/")}); document.body.append(h);
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

    const run = async (proxied: boolean): Promise<{ out: string[]; got: string[]; escaped: string[] }> => {
        const url = proxied ? `${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page` : `http://127.0.0.1:${port0}/page`;
        got = [];
        const p = await browser.newPage();
        const escaped: string[] = [];
        p.on("request", (r) => { const x = r.url(); if (proxied && /^https?:/.test(x) && !x.startsWith(proxyOrigin)) escaped.push(x); });
        await p.goto(url);
        await p.evaluate(() => new Promise((res) => setTimeout(res, 2000)));
        const out = await p.evaluate(() => (window as unknown as { out: string[] }).out);
        await p.close();
        return { out: [...out].sort(), got: [...new Set(got)].sort(), escaped };
    };

    it("load through the proxy, and read as directly", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        const names = ["attr", "b64", "object", "setter", "static", "svg", "svgembed", "svgset"];
        expect(direct.out.map((x) => x.split(" ").slice(0, 2).join(" "))).toEqual(names.map((n) => n + " null"));
        expect(direct.got).toEqual(names.flatMap((n) => [n + "fetch", n + "img"]).sort());
        expect(proxied.out).toEqual(direct.out);
        expect(proxied.got).toEqual(direct.got);
        expect(proxied.escaped).toEqual([]);
    }, 60_000);
});
