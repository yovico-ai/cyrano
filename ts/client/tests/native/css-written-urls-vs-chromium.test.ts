// @vitest-environment node
//
// CSS URLs read back as the page wrote them, in real Chromium, direct and
// through the real proxy: a specified value (a rule's cssText, a
// declaration) keeps a relative URL relative; a computed one is absolute.
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

describe.skipIf(!wanted)("CSS URLs as written, in Chromium, through the proxy", () => {
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
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(`<!doctype html><style>.a { background-image: url(img/a.png); } .q { background-image: url("../q.png"); }</style>
<div id="d" style="background-image: url(img/b.png)"></div><div class="a" id="e"></div><script>
const s = document.createElement("style"); s.textContent = ".m { background-image: url(img/m.png); }"; document.head.append(s);
s.sheet.insertRule(".i { background-image: url('img/i.png'); }", 0);
const c = new CSSStyleSheet(); c.replaceSync(".c { background-image: url(img/c.png); }"); document.adoptedStyleSheets = [c];
const f = document.createElement("div"); f.style.backgroundImage = "url(img/f.png)"; f.style.setProperty("border-image-source", "url(/r.png)"); document.body.append(f);
window.out = {
  rules: [...document.styleSheets[0].cssRules].map((r) => r.cssText),
  made: [...s.sheet.cssRules].map((r) => r.cssText),
  constructed: c.cssRules[0].cssText,
  attr: d.style.backgroundImage, attrText: d.style.cssText,
  set: f.style.backgroundImage, setText: f.style.cssText, prop: f.style.getPropertyValue("border-image-source"),
  ruleStyle: document.styleSheets[0].cssRules[0].style.backgroundImage,
  computed: getComputedStyle(e).backgroundImage.replace(/\\/\\/[^/]+/, "//H"),
};
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

    const run = async (proxied: boolean): Promise<unknown> => {
        const url = proxied ? `${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page` : `http://127.0.0.1:${port0}/page`;
        const p = await browser.newPage();
        await p.goto(url);
        await new Promise((res) => setTimeout(res, 1500));
        const out = await p.evaluate(() => (window as unknown as { out: unknown }).out);
        await p.close();
        return out;
    };

    it("read back as the page wrote them", async () => {
        const direct = await run(false) as Record<string, unknown>;
        const proxied = await run(true);
        expect(direct.attr).toBe('url("img/b.png")');
        expect(String(direct.computed)).toContain("//H/img/a.png");
        expect(proxied).toEqual(direct);
    }, 60_000);
});
