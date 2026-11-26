// @vitest-environment node
//
// A page's own fetch directives, in real Chromium, direct and through the
// real proxy (spec/Csp.agda cspRefuses). The browser is given a policy
// that admits the proxy, where every proxied resource is: a script the
// page's policy refuses ran (awishcometrue.com: Mailchimp's script,
// refused directly, replaced the page's jQuery and broke its carousel).
// The proxy refuses what the page's policies refuse, by the original URLs,
// with a redirect the browser's own policy refuses too: the browser
// reports the violation itself — a trusted securitypolicyviolation event
// naming the page's URL (spec Csp.refusalLocation). Not compared: its
// sourceFile / lineNumber, which Chromium leaves empty for a refusal at a
// redirect (a limit: directly they name the script that made the request).
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

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const PAGE = (allowed: string, refused: string): string => `<!doctype html>
<meta http-equiv="content-security-policy" content="img-src 'self' ${allowed}">
<script>
window.violations = [];
document.addEventListener("securitypolicyviolation", (e) => violations.push({ blockedURI: e.blockedURI, documentURI: e.documentURI, violatedDirective: e.violatedDirective,
  effectiveDirective: e.effectiveDirective, originalPolicy: e.originalPolicy, disposition: e.disposition, statusCode: e.statusCode,
  target: e.target === document ? "document" : String(e.target && e.target.nodeName), isTrusted: e.isTrusted, bubbles: e.bubbles, composed: e.composed }));
window.out = (async () => {
  const o = {};
  const script = (u) => new Promise((ok) => { const s = document.createElement("script"); s.src = u; s.onload = () => ok("load"); s.onerror = () => ok("error"); document.head.append(s); });
  const img = (u) => new Promise((ok) => { const i = new Image(); i.onload = () => ok("load"); i.onerror = () => ok("error"); i.src = u; });
  o.scriptAllowed = await script("${allowed}/a.js");
  o.scriptRefused = await script("${refused}/r.js");
  o.scriptSelf = await script("/s.js");
  o.imgAllowed = await img("${allowed}/a.png");
  o.imgRefused = await img("${refused}/r.png");
  try { o.fetchRefused = (await fetch("${refused}/f")).status; } catch (e) { o.fetchRefused = e.name; }
  try { o.fetchAllowed = (await fetch("${allowed}/f")).status; } catch (e) { o.fetchAllowed = e.name; }
  o.ran = window.ran || [];
  await new Promise((r) => setTimeout(r, 300));
  o.violations = violations.map((v) => JSON.stringify(v)).sort();
  return o;
})();
</script>`;

describe.skipIf(!wanted)("a page's own CSP, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;
    let other: Server;
    let otherHits: string[] = [];
    let allowed: Server;
    let allowedOrigin = "", refusedOrigin = "";

    beforeAll(async () => {
        const serve = (tag: string) => (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void => {
            const u = new URL(req.url ?? "/", "http://x");
            if (tag !== "page") otherHits.push(tag + u.pathname);
            const h: Record<string, string> = { "access-control-allow-origin": "*" };
            if (u.pathname.endsWith(".js")) { res.writeHead(200, { ...h, "content-type": "text/javascript" }); res.end(`window.ran = (window.ran || []).concat(${JSON.stringify(tag + u.pathname)});`); return; }
            if (u.pathname.endsWith(".png")) { res.writeHead(200, { ...h, "content-type": "image/png" }); res.end(PNG); return; }
            if (u.pathname === "/f") { res.writeHead(200, h); res.end("ok"); return; }
            res.writeHead(200, { "content-type": "text/html", "content-security-policy": `script-src 'self' 'unsafe-inline' ${allowedOrigin}; connect-src 'self' ${allowedOrigin}` });
            res.end(PAGE(allowedOrigin, refusedOrigin));
        };
        other = createServer(serve("refused"));
        await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
        refusedOrigin = `http://127.0.0.1:${(other.address() as { port: number }).port}`;
        allowed = createServer(serve("allowed"));
        await new Promise<void>((r) => allowed.listen(0, "127.0.0.1", () => r()));
        allowedOrigin = `http://127.0.0.1:${(allowed.address() as { port: number }).port}`;
        upstream = createServer(serve("page"));
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
        other?.close();
        allowed?.close();
    });

    const run = async (url: string): Promise<{ out: unknown; hits: string[] }> => {
        otherHits = [];
        const page = await browser.newPage();
        await page.goto(url);
        const out = await page.evaluate(() => (window as unknown as { out: Promise<unknown> }).out);
        await page.close();
        return { out, hits: otherHits.filter((h) => h.startsWith("refused")).sort() };
    };

    it("refuses what the page's policy refuses, as directly", async () => {
        const direct = await run(`http://localhost:${port0}/page`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/localhost:${port0}/page`);
        expect(direct.out).toMatchObject({ scriptAllowed: "load", scriptRefused: "error", scriptSelf: "load", imgAllowed: "load", imgRefused: "error", fetchRefused: "TypeError", fetchAllowed: 200 });
        expect(proxied.out).toEqual(direct.out);
        expect(proxied.hits).toEqual(direct.hits); // nothing refused reaches the origin
    }, 120_000);
});
