// @vitest-environment node
//
// Markup in shadow roots read back as the page wrote it, in real Chromium,
// direct and through the real proxy (round I: inside a declarative shadow
// root — <template shadowrootmode> the server rewrote — getAttribute gave
// the proxified URL, crn-o showed in getAttributeNames and innerHTML;
// round J: getHTML({serializableShadowRoots}) of a script-filled root).
// The originals are taken when the page gets hold of a root, or reads an
// element of it; a root's innerHTML is built without the runtime's
// insertion fix-ups (they proxified the restored copies again).
//
// Runs the server binary (go/assets/cyrano: ./go/scripts/build.sh) on a
// free port. Needs it and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const binary = process.env.CYRANO_BINARY ?? resolve(root, "go/assets/cyrano");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(binary);

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

const SCRIPT = `
window.out = (async () => {
  const s = document.getElementById("h").shadowRoot;
  const out = { href: s.getElementById("a").getAttribute("href"), src: s.querySelector("img").getAttribute("src"),
    names: [...s.querySelectorAll("*")].map((e) => e.getAttributeNames().join(",")).join("|"), inner: s.innerHTML, gh: s.getHTML(),
    hostGh: document.getElementById("h2").getHTML({ serializableShadowRoots: true }) };
  const k = document.createElement("div"); document.body.append(k);
  const sr = k.attachShadow({ mode: "open", serializable: true }); sr.innerHTML = '<img src="/lg?a"><a href="/p">l</a>';
  out.scripted = [sr.innerHTML, sr.getHTML(), k.getHTML({ serializableShadowRoots: true })];
  return out;
})();
`;

describe.skipIf(!wanted)("shadow roots read back, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let self = "";
    let other = "";
    let proxyOrigin = "";

    beforeAll(async () => {
        upstream = createServer((q, r) => {
            const u = new URL(q.url ?? "/", "http://x");
            if (u.pathname !== "/page.html") { r.writeHead(404); return r.end(); }
            r.writeHead(200, { "content-type": "text/html" });
            return r.end('<!doctype html><body><div id=h><template shadowrootmode=open><style>b{background:url(/i.png)}</style><a id=a href="/rel?ds">l</a><img src="/x.png"></template></div>' +
                '<div id=h2><template shadowrootmode=open shadowrootserializable><a href="https://cdn.example/z">z</a></template>light</div><script>' + SCRIPT.replace("OTHER", other) + "</script></body>");
        });
        await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
        const p0 = (upstream.address() as { port: number }).port;
        self = `http://127.0.0.1:${p0}`;
        other = `http://localhost:${p0}`;
        const port = await free();
        proxyOrigin = `http://localhost:${port}`;
        proxy = spawn(binary, ["--assets", resolve(root, "go/assets"), "--log-level", "warn"], {
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

    it("reads back as written", async () => {
        const direct = await run(`${self}/page.html`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/${self.slice(7)}/page.html`);
        expect((direct as { href: string }).href).toBe("/rel?ds");
        expect(proxied).toEqual(direct);
    }, 90_000);
});
