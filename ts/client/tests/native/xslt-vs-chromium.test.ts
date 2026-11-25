// @vitest-environment node
//
// An XML document styled by XSLT, in real Chromium, through the real proxy
// (spec/XmlDoc.agda xslNetPolicy). The transformation's output replaces
// the document (the bootstrap with it) and loaded the stylesheet, script
// and images it names from their origins (round I: sitemaps, feeds). The
// document is given a policy admitting the proxy alone: the output keeps
// it, so nothing leaves the proxy — what it names relative still loads.
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

const XSL = (other: string): string => `<?xml version="1.0"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
<xsl:output method="html"/>
<xsl:template match="/"><html><head><link rel="stylesheet" href="${other}/x.css"/><script src="${other}/x.js"></script></head>
<body><img src="${other}/x.png"/><img id="rel" src="/rel.png"/><p id="p"><xsl:value-of select="count(//url)"/></p></body></html></xsl:template>
</xsl:stylesheet>`;
const XML = `<?xml version="1.0"?><?xml-stylesheet type="text/xsl" href="/sm.xsl"?><urlset><url/><url/></urlset>`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

describe.skipIf(!wanted)("an XSLT-styled document, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;
    let other: Server;
    let otherHits: string[] = [];

    beforeAll(async () => {
        other = createServer((req, res) => { otherHits.push(req.url ?? ""); res.writeHead(200, { "content-type": req.url?.endsWith(".png") ? "image/png" : "text/plain" }); res.end(req.url?.endsWith(".png") ? PNG : ""); });
        await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
        const otherOrigin = `http://127.0.0.1:${(other.address() as { port: number }).port}`;
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/sm.xsl") { res.writeHead(200, { "content-type": "text/xsl" }); return res.end(XSL(otherOrigin)); }
            if (u.pathname === "/rel.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG); }
            res.writeHead(200, { "content-type": "text/xml" });
            return res.end(XML);
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
        other?.close();
    });

    const run = async (url: string): Promise<{ hits: string[]; p: string; rel: boolean }> => {
        otherHits = [];
        const page = await browser.newPage();
        await page.goto(url);
        await new Promise((r) => setTimeout(r, 800));
        const o = await page.evaluate(() => { const r = document.getElementById("rel") as HTMLImageElement | null; return { p: document.getElementById("p")?.textContent ?? "", rel: !!r && r.complete && r.naturalWidth > 0 }; });
        await page.close();
        return { hits: otherHits.slice().sort(), ...o };
    };

    it("loads nothing from another origin", async () => {
        const direct = await run(`http://localhost:${port0}/sm.xml`);
        expect(direct.hits.length).toBeGreaterThan(0); // the escape that would be
        expect(direct.p).toBe("2");
        const proxied = await run(`${proxyOrigin}/cyrano/http/localhost:${port0}/sm.xml`);
        expect(proxied.hits).toEqual([]);
        expect(proxied.p).toBe("2");
        expect(proxied.rel).toBe(true);
    }, 120_000);
});
