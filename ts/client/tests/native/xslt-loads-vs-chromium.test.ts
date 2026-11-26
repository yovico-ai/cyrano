// @vitest-environment node
//
// An XSLT stylesheet's own loads (xsl:import, xsl:include, document()), in
// real Chromium, direct and through the real proxy (spec/XmlDoc.agda
// rewriteXsl; Disposition.xslDest; patches/xslt.ts). The browser's XSLT
// loader takes its own origin only — through the proxy the proxy's — so a
// stylesheet naming the origin by absolute URL failed where directly it
// ran: through XSLTProcessor and in an XSLT-styled document.
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

const XSL = (port: number, root: string): string => `<?xml version="1.0"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
<xsl:import href="http://127.0.0.1:${port}/imp.xsl"/>
<xsl:include href="inc.xsl"/>
<xsl:output method="html"/>
<xsl:template match="/">${root}<b id="v"><xsl:value-of select="document('http://127.0.0.1:${port}/doc.xml')/r"/></b><i id="w"><xsl:call-template name="fromImport"/></i><u id="x"><xsl:call-template name="fromInclude"/></u>${root ? "</body></html>" : ""}</xsl:template>
</xsl:stylesheet>`;
const IMP = `<?xml version="1.0"?><xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:template name="fromImport">imported</xsl:template></xsl:stylesheet>`;
const INC = `<?xml version="1.0"?><xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:template name="fromInclude">included</xsl:template></xsl:stylesheet>`;

const PAGE = (): string => `<!doctype html><body><script>
window.out = (async () => {
  try {
    const p = new XSLTProcessor();
    const x = await (await fetch("/s.xsl")).text();
    const ps = new DOMParser();
    p.importStylesheet(ps.parseFromString(x, "text/xml"));
    const f = p.transformToFragment(ps.parseFromString("<d/>", "text/xml"), document);
    document.body.append(f);
    return ["v", "w", "x"].map((k) => document.getElementById(k)?.textContent ?? "-").join(" ");
  } catch (e) { return e.name; }
})();
</script>`;

describe.skipIf(!wanted)("an XSLT stylesheet\u2019s own loads, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let port0 = 0;

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            const xsl = (b: string) => { res.writeHead(200, { "content-type": "text/xsl" }); res.end(b); };
            if (u.pathname === "/s.xsl") return xsl(XSL(port0, ""));
            if (u.pathname === "/styled.xsl") return xsl(XSL(port0, "<html><body>"));
            if (u.pathname === "/imp.xsl") return xsl(IMP);
            if (u.pathname === "/inc.xsl") return xsl(INC);
            if (u.pathname === "/doc.xml") { res.writeHead(200, { "content-type": "text/xml" }); return res.end("<r>docd</r>"); }
            if (u.pathname === "/styled.xml") { res.writeHead(200, { "content-type": "text/xml" }); return res.end(`<?xml version="1.0"?><?xml-stylesheet type="text/xsl" href="/styled.xsl"?><d/>`); }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(PAGE());
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

    const run = async (url: string, styled: boolean): Promise<unknown> => {
        const page = await browser.newPage();
        await page.goto(url);
        const out = styled
            ? await page.evaluate(() => new Promise((ok) => setTimeout(() => ok(["v", "w", "x"].map((k) => document.getElementById(k)?.textContent ?? "-").join(" ")), 800)))
            : await page.evaluate(() => (window as unknown as { out: Promise<unknown> }).out);
        await page.close();
        return out;
    };

    it("XSLTProcessor imports and reads as directly", async () => {
        const direct = await run(`http://127.0.0.1:${port0}/page`, false);
        const proxied = await run(`${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/page`, false);
        // (Chromium's XSLTProcessor reads nothing by document(), measured)
        expect(direct).toBe(" imported included");
        expect(proxied).toBe(direct);
    }, 120_000);

    it("an XSLT-styled document imports and reads as directly", async () => {
        const direct = await run(`http://127.0.0.1:${port0}/styled.xml`, true);
        const proxied = await run(`${proxyOrigin}/cyrano/http/127.0.0.1:${port0}/styled.xml`, true);
        expect(direct).toBe("docd imported included");
        expect(proxied).toBe(direct);
    }, 120_000);
});
