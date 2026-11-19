// @vitest-environment node
//
// spec/Priority.agda against Chromium over HTTP/2: for the commonest case
// of each destination (a stylesheet and a script in the head, a font, an
// image added by script, media, frames, workers, fetch / XHR, a beacon, a
// prefetch) the Priority Chromium sends is the spec's (`priority`) from the
// request's Sec-Fetch-Dest, Sec-Fetch-Mode, method and Sec-Purpose. The
// other cases the spec names (a script in the body, async, the first
// images, fetchpriority) are loaded too and must differ as it says.
//
// Needs the oracle, openssl and Playwright's Chromium; `make browser-check`.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createSecureServer, type Http2SecureServer } from "node:http2";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { goto(u: string): Promise<unknown>; waitForTimeout(ms: number): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(o: object): Promise<Context>; close(): Promise<void> };

// Path → what Chromium sends when it is not the commonest case (else "spec").
const CASES: Record<string, string> = {
    "/": "spec", "/s.css": "spec", "/h.js": "spec", "/f.woff2": "spec", "/m.js": "spec", "/j.json": "spec", "/fr": "spec", "/ob.html": "spec", "/em.html": "spec",
    "/ji.png": "spec", "/lz.png": "spec", "/v.mp4": "spec", "/a.mp3": "spec", "/tr.vtt": "spec", "/w.js": "spec", "/sw.js": "spec", "/svc.js": "spec",
    "/fe": "spec", "/xhr": "spec", "/pc": "spec", "/nc": "spec", "/es": "spec", "/bc": "spec", "/pf": "spec",
    "/b.js": "u=2", "/as.js": "none", "/df.js": "none", "/i.png": "u=2, i", "/lo": "i", "/pn": "u=1, i",
};

const PAGE = `<!doctype html><html><head><link rel=stylesheet href=/s.css><script src=/h.js></script>
<style>@font-face{font-family:f;src:url(/f.woff2)}body{font-family:f}</style><link rel=prefetch href=/pf></head>
<body>text<img src=/i.png><img src=/lz.png loading=lazy><video src=/v.mp4><track src=/tr.vtt default kind=subtitles></video><audio src=/a.mp3 preload=auto></audio>
<iframe src=/fr></iframe><object data=/ob.html type=text/html></object><embed src=/em.html type=text/html>
<script src=/b.js></script><script async src=/as.js></script><script defer src=/df.js></script><script type=module src=/m.js></script>
<script type=module>import j from "/j.json" with {type: "json"};</script>
<script>fetch("/fe"); fetch("/nc", {mode: "no-cors"}); fetch("/pc", {method: "POST", body: "x"}); fetch("/pn", {method: "POST", mode: "no-cors", body: "x"});
fetch("/lo", {priority: "low"}); new Worker("/w.js"); new SharedWorker("/sw.js"); navigator.sendBeacon("/bc", "x"); new Image().src = "/ji.png";
new EventSource("/es"); const x = new XMLHttpRequest(); x.open("GET", "/xhr"); x.send(); navigator.serviceWorker.register("/svc.js");</script></body></html>`;

describe.skipIf(!wanted || located.skip !== "")("Priority over HTTP/2: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Http2SecureServer;
    let port = 0;
    const seen = new Map<string, { dest: string; mode: string; method: string; purpose: string; priority: string }>();

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        const dir = mkdtempSync(join(tmpdir(), "prio-"));
        execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-days", "2", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")], { stdio: "ignore" });
        server = createSecureServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (req, res) => {
            const h = req.headers;
            const s = (n: string): string => String(h[n] ?? "");
            seen.set(req.url, { dest: s("sec-fetch-dest"), mode: s("sec-fetch-mode"), method: req.method, purpose: s("sec-purpose"), priority: h["priority"] === undefined ? "none" : s("priority") });
            const type = req.url === "/" || req.url.endsWith(".html") || req.url === "/fr" ? "text/html" : req.url.endsWith(".js") ? "text/javascript" : req.url.endsWith(".json") ? "application/json" : "";
            if (type !== "") res.setHeader("content-type", type);
            res.end(req.url === "/" ? PAGE : req.url.endsWith(".json") ? "{}" : "");
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        oracle?.close();
        await browser?.close();
        server?.close();
    });

    it("each destination's commonest case sends the spec's Priority", async () => {
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await ctx.newPage();
        await page.goto(`https://localhost:${port}/`);
        for (let i = 0; i < 40 && seen.size < Object.keys(CASES).length; i++) await page.waitForTimeout(100);
        await ctx.close();
        const bad: string[] = [];
        for (const [path, other] of Object.entries(CASES)) {
            const r = seen.get(path);
            if (r === undefined) { bad.push(`${path}: not requested`); continue; }
            const spec = await oracle.ask("priority", [r.dest, r.mode, r.method, r.purpose]);
            const want = other === "spec" ? spec : other;
            if (r.priority !== want) bad.push(`${path} (${r.dest} ${r.mode} ${r.method} ${r.purpose}): Chromium ${r.priority}, ${other === "spec" ? "spec" : "noted"} ${want}`);
            if (other !== "spec" && other === spec) bad.push(`${path}: noted as differing, but the spec gives ${spec}`);
        }
        expect(bad, String(bad.length)).toEqual([]);
    }, 60_000);
});
