// @vitest-environment node
//
// Subresource Integrity, in real Chromium, direct and through the real
// proxy (spec/Sri.agda; Containment integrityText). Through the proxy a
// script's or stylesheet's bytes are rewritten, so both rewriters drop
// `integrity` — and nothing was checked: a script that does not match ran,
// a stylesheet applied, `script.integrity` read "" (round K). The URL now
// carries the metadata and the proxy checks the origin's bytes.
//
// Needs the server binary and Playwright's Chromium; `make browser-check`.

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
type Page = { goto(u: string): Promise<unknown>; reload(): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; on(e: "request", f: (r: Req) => void): void; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };



const free = (): Promise<number> => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

import { createHash } from "node:crypto";

const BODY = "window.ran = (window.ran || []).concat(document.currentScript ? document.currentScript.dataset.k : 'dyn');";
const CSS = "#x { color: rgb(1, 2, 3); }";
const h = (a: string, b: string): string => createHash(a).update(b).digest("base64");
const b64u = (s: string): string => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const S256 = h("sha256", BODY), S384 = h("sha384", BODY), S512 = h("sha512", BODY);
const BAD = "sha256-" + "A".repeat(43) + "=";
const CASES: Record<string, string> = {
    ok: "sha256-" + S256, upper: "SHA256-" + S256, url: "sha256-" + b64u(S256), nopad: "sha256-" + S256.replace(/=+$/, ""),
    opts: "sha256-" + S256 + "?foo", bad: BAD, weakOkStrongBad: "sha256-" + S256 + " sha384-" + "A".repeat(64),
    weakBadStrongOk: BAD + " sha512-" + S512, twoStrong: "sha384-" + "B".repeat(64) + " sha384-" + S384, junk: "md5-xxx nonsense", empty: "",
};
const page = (port: number): string => "<!doctype html><p id=x>x</p>"
    + Object.entries(CASES).map(([k, v]) => `<script data-k="${k}" src="/s.js?${k}" integrity="${v}"></script>`).join("")
    + `<script data-k="xnc" src="http://localhost:${port}/s.js?xnc" integrity="sha256-${S256}"></script>`
    + `<script data-k="xcors" crossorigin src="http://localhost:${port}/s.js?xcors" integrity="sha256-${S256}"></script>`
    + `<link rel=stylesheet href="/s.css?bad" integrity="${BAD}">`
    + `<script>
window.out = new Promise((done) => addEventListener("load", async () => {
  const o = { color: getComputedStyle(document.getElementById("x")).color, idl: document.scripts[0].integrity };
  // set by script: integrity before src, after src, and a wrong one
  const add = (k, first, v) => new Promise((r) => { const s = document.createElement("script"); s.dataset.k = k;
    if (first) s.integrity = v; s.src = "/s.js?" + k; if (!first) s.integrity = v;
    s.onload = () => r(k + ":load"); s.onerror = () => r(k + ":error"); document.head.append(s); });
  o.dyn = [await add("dynBefore", true, "sha256-${S256}"), await add("dynAfter", false, "sha256-${S256}"), await add("dynBad", false, "${BAD}"), await add("dynBadAttr", true, "${BAD}")];
  o.dynIdl = (() => { const s = document.createElement("script"); s.integrity = "sha384-x"; return [s.integrity, s.getAttribute("integrity")]; })();
  o.ran = (window.ran || []).slice().sort();
  done(o);
}));
</script>`;

describe.skipIf(!wanted)("Subresource Integrity, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/s.js") { res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" }); return res.end(BODY); }
            if (u.pathname === "/s.css") { res.writeHead(200, { "content-type": "text/css" }); return res.end(CSS); }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(page(port0));
        });
        await new Promise<void>((r) => upstream.listen(0, "0.0.0.0", () => r()));
        port0 = (upstream.address() as { port: number }).port;
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

    it("checks integrity as directly", async () => {
        const direct = await run(`http://127.0.0.1:${port0}/page`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page`);
        expect(direct).toMatchObject({ color: "rgb(0, 0, 0)", idl: CASES.ok });
        expect((direct as { ran: string[] }).ran).not.toContain("bad");
        expect(proxied).toEqual(direct);
    }, 120_000);
});
