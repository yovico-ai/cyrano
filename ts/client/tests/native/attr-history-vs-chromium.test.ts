// @vitest-environment node
//
// What attributes held before, in real Chromium, direct and through the
// real proxy (round J): a MutationRecord's oldValue and a customized
// built-in's attributeChangedCallback values held the proxified URLs. Now
// as the page wrote them (patches/attr-history.ts). A style the page wrote
// with a relative URL reads back absolute (a gap): absolute here.
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

describe.skipIf(!wanted)("what attributes held before, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname !== "/page") { res.writeHead(404); return res.end(); }
            const b = `http://localhost:${port0}`;
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><script>
window.out = [];
const rel = (s) => s === null ? "null" : String(s).split(location.origin).join("O").split("${b}").join("X");
new MutationObserver((rs) => { for (const r of rs) out.push("M " + r.attributeName + " " + rel(r.oldValue)); }).observe(document, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ["src", "href", "style"] });
class XI extends HTMLImageElement { static observedAttributes = ["src"]; attributeChangedCallback(n, o, v) { out.push("C " + n + " " + rel(o) + " -> " + rel(v)); } }
customElements.define("x-img", XI, { extends: "img" });
</script>
<img id=i src="${b}/lg?mo1"><a id=a href="/x">a</a><iframe id=f src="/wn2"></iframe><div id=d></div><img is="x-img" id=c src="/lg?ce1">
<script>
document.getElementById("i").src = "${b}/lg?mo3";
document.getElementById("a").href = "/y";
document.getElementById("f").src = "/wn3";
const d = document.getElementById("d"); d.style.cssText = "background: url(${b}/lg?a)"; d.style.cssText = "color: red";
const c = document.getElementById("c"); c.src = "/lg?ce2";
const e = document.createElement("img", { is: "x-img" }); e.setAttribute("src", "${b}/p1"); e.setAttribute("src", "${b}/p2");
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

    const run = async (proxied: boolean): Promise<string[]> => {
        const url = proxied ? `${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page` : `http://127.0.0.1:${port0}/page`;
        const p = await browser.newPage();
        await p.goto(url);
        await p.evaluate(() => new Promise((res) => setTimeout(res, 1000)));
        const out = await p.evaluate(() => (window as unknown as { out: string[] }).out);
        await p.close();
        return out;
    };

    it("read as the page wrote them, as directly", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        expect(direct).toEqual([
            "C src null -> /lg?ce1", "C src /lg?ce1 -> /lg?ce2", "C src null -> X/p1", "C src X/p1 -> X/p2",
            "M src X/lg?mo1", "M href /x", "M src /wn2", "M style null", "M style background: url(\"X/lg?a\");", "M src /lg?ce1",
        ]);
        expect(proxied).toEqual(direct);
    }, 60_000);
});
