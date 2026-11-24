// @vitest-environment node
//
// Stylesheets read through CSSOM, in real Chromium, direct and through the
// real proxy (round H/I/K: a sheet's href and an @import's named the
// proxified URL; a cross-origin sheet loaded without CORS gave its rules,
// where directly cssRules throws SecurityError — how font loaders and
// fingerprinters tell a third-party sheet; rule text, inline styles and
// computed values held proxied URLs). Now as directly: hrefs and text read
// back, a muted sheet throws Chromium's SecurityError (an @import of
// another origin too, in any sheet). Gap: a URL the page wrote relative
// reads back absolute.
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

describe.skipIf(!wanted)("stylesheets through CSSOM, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname.endsWith(".css")) {
                res.writeHead(200, { "content-type": "text/css", "access-control-allow-origin": "*" });
                return res.end(u.pathname === "/imp.css" ? "i { color: blue }" : `@import url("http://localhost:${port0}/imp.css"); body { color: red; background: url("http://localhost:${port0}/bg.png") }`);
            }
            if (u.pathname.endsWith(".png")) { res.writeHead(404); return res.end(); }
            const b = `http://localhost:${port0}`;
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><link rel=stylesheet href="${b}/x.css"><link rel=stylesheet crossorigin href="${b}/c.css?cors"><link rel=stylesheet href="/s.css">
<body><div id=d></div><script>
window.out = null;
const rel = (s) => String(s).split(location.origin).join("O").split("${b}").join("X");
addEventListener("load", () => {
  const o = [];
  for (const sh of document.styleSheets) {
    let rules;
    try { rules = sh.cssRules.length + " " + rel(sh.cssRules[1] ? sh.cssRules[1].cssText : ""); } catch (e) { rules = e.name + ": " + e.message; }
    let ins;
    try { sh.insertRule("p { color: green }", 0); ins = "ok"; } catch (e) { ins = e.name + ": " + e.message; }
    let imp = "";
    try { const r = sh.cssRules[sh.cssRules[0].type === 3 ? 0 : 1]; if (r && r.type === 3) { imp = rel(r.href) + " | " + rel(r.styleSheet && r.styleSheet.href); try { imp += " | " + r.styleSheet.cssRules.length; } catch (e) { imp += " | " + e.name; } } } catch (e) { imp = "-"; }
    o.push(rel(sh.href) + " | " + rules + " | " + ins + " | " + imp);
  }
  const d = document.getElementById("d"); d.style.backgroundImage = "url(${b}/i.png?s=1)";
  o.push("inline " + rel(d.style.backgroundImage) + " | " + rel(d.style.cssText) + " | " + rel(getComputedStyle(d).backgroundImage) + " | " + rel(d.style.getPropertyValue("background-image")));
  window.out = o;
});
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
        await p.evaluate(() => new Promise((res) => setTimeout(res, 1500)));
        const out = await p.evaluate(() => (window as unknown as { out: string[] }).out);
        await p.close();
        return out;
    };

    it("read as directly", async () => {
        const direct = await run(false);
        const proxied = await run(true);
        const sec = "SecurityError: Failed to read the 'cssRules' property from 'CSSStyleSheet': Cannot access rules | SecurityError: Failed to execute 'insertRule' on 'CSSStyleSheet': Cannot access StyleSheet to insertRule | -";
        const hier = "HierarchyRequestError: Failed to execute 'insertRule' on 'CSSStyleSheet': Failed to insert the rule.";
        const body = "2 body { color: red; background: url(\"X/bg.png\"); }";
        expect(direct).toEqual([
            `X/x.css | ${sec}`,
            `X/c.css?cors | ${body} | ${hier} | X/imp.css | X/imp.css | SecurityError`,
            `O/s.css | ${body} | ${hier} | X/imp.css | X/imp.css | SecurityError`,
            "inline url(\"X/i.png?s=1\") | background-image: url(\"X/i.png?s=1\"); | url(\"X/i.png?s=1\") | url(\"X/i.png?s=1\")",
        ]);
        expect(proxied).toEqual(direct);
    }, 60_000);
});
