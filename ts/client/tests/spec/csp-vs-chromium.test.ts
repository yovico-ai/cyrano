// @vitest-environment node
//
// CSP in real Chromium: the page cannot tell. A page under its origin's
// policy, and the same page proxied under the policy spec/Csp.agda
// translates it to (`csp header`), load the same probes — images, an
// external script, inline scripts (with and without the nonce), a
// stylesheet, a fetch. Whatever loads directly must load proxied; and the
// runtime's bootstrap must run there, inline with the nonce the spec
// chooses (`cspnonce`) where the spec says an inline script may run
// (`cspinline`), else as an external script, as the server serves it.
//
// The translation weakens policies (CLAUDE.md, known gap): a probe that
// loads only proxied is allowed, and counted, not failed.
//
// Proxied inline scripts differ from the page's (the rewriter edits them),
// so a hash of the page's script does not match them — as in the proxy.
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T, a: A): Promise<T>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void>; version(): string };

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const NONCE = "n0nce";
const INLINE_NONCED = "(window.__p=window.__p||{}).inlineNonce=1;";
const INLINE_PLAIN = "(window.__p=window.__p||{}).inlinePlain=1;";
const sha = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;
const PROBES = ["imgCdn", "imgSelf", "scriptCdn", "inlineNonce", "inlinePlain", "styleCdn", "fetchCdn"] as const;

describe.skipIf(!wanted || located.skip !== "")("CSP: the page cannot tell, in Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;
    // The current draw: the origin's policy and its translation.
    let current = { policy: "", translated: "", nonce: null as string | null, inline: true };

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req, res) => {
            const host = (req.headers.host ?? "").split(":")[0]!;
            let path = req.url ?? "/";
            let proxied = false;
            if (host === "proxy.localhost") {
                const m = /^\/cyrano\/http\/([^/]+)(\/.*)$/.exec(path);
                if (m) { proxied = true; path = m[2]!; }
                if (path === "/boot.js") {
                    res.writeHead(200, { "content-type": "text/javascript" });
                    res.end("(window.__p=window.__p||{}).boot=1;");
                    return;
                }
            }
            const p = (h: string, rest: string) => (proxied ? `http://proxy.localhost:${port}/cyrano/http/${h}:${port}${rest}` : `http://${h}:${port}${rest}`);
            if (path === "/page") {
                const headers: Record<string, string> = { "content-type": "text/html" };
                const pol = proxied ? current.translated : current.policy;
                if (pol !== "") headers["content-security-policy"] = pol;
                res.writeHead(200, headers);
                // The proxied page: the bootstrap first (inline with the
                // spec's nonce, or external), and edited inline scripts.
                const edit = proxied ? "/*crn*/" : "";
                const boot = !proxied ? "" : current.inline
                    ? `<script${current.nonce !== null ? ` nonce="${current.nonce}"` : ""}>(window.__p=window.__p||{}).boot=1;</script>`
                    : `<script src="http://proxy.localhost:${port}/boot.js"${current.nonce !== null ? ` nonce="${current.nonce}"` : ""}></script>`;
                res.end(`<!doctype html><head>${boot}
<link id="styleCdn" rel="stylesheet" href="${p("cdn.localhost", "/s.css")}">
<script src="${p("cdn.localhost", "/s.js")}" nonce="${NONCE}"></script>
<script nonce="${NONCE}">${INLINE_NONCED}${edit}</script>
<script>${INLINE_PLAIN}${edit}</script>
</head><body><img id="imgCdn" src="${p("cdn.localhost", "/x.png")}"><img id="imgSelf" src="${p("a.localhost", "/y.png")}"></body>`);
                return;
            }
            if (path.endsWith(".png")) { res.writeHead(200, { "content-type": "image/png" }); res.end(PNG); return; }
            if (path === "/s.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end("(window.__p=window.__p||{}).scriptCdn=1;"); return; }
            if (path === "/s.css") { res.writeHead(200, { "content-type": "text/css" }); res.end("body{}"); return; }
            if (path === "/data.txt") { res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }); res.end("ok"); return; }
            res.writeHead(404); res.end();
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

    it("what loads directly loads proxied, and the bootstrap runs", async () => {
        const cdn = `http://cdn.localhost:${port}`;
        const values = ["'self'", "'none'", "'unsafe-inline'", "'strict-dynamic'", `'nonce-${NONCE}'`, sha(INLINE_NONCED), sha(INLINE_PLAIN),
            cdn, "http://*.localhost:*", "http:", "data:", "*", "https://elsewhere.example"];
        const directive = fc.tuple(
            fc.constantFrom("default-src", "script-src", "script-src-elem", "img-src", "style-src", "connect-src", "report-uri", "trusted-types"),
            fc.array(fc.constantFrom(...values), { minLength: 1, maxLength: 4 }),
        ).map(([n, vs]) => [n, ...vs].join(" "));
        const policy = fc.array(directive, { maxLength: 4 }).map((ds) => ds.join("; "));
        const header = fc.tuple(policy, fc.option(policy, { nil: undefined })).map(([a, b]) => (b === undefined ? a : `${a}, ${b}`));
        const draws = fc.sample(header, { numRuns: 120, seed: Number(process.env.CYRANO_SEED ?? Date.now() % 1e9) });

        const proxyOrigin = `http://proxy.localhost:${port}`;
        const run = async (url: string) => {
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            await page.goto(url);
            const out = await page.evaluate(async (a: { cdn: string }) => {
                const p = ((window as unknown as { __p?: Record<string, number> }).__p) ?? {};
                const img = (id: string) => { const e = document.getElementById(id) as HTMLImageElement | null; return !!e && e.complete && e.naturalWidth > 0; };
                const link = document.getElementById("styleCdn") as HTMLLinkElement | null;
                let fetchCdn = false;
                try { fetchCdn = (await (await fetch(a.cdn)).text()) === "ok"; } catch { fetchCdn = false; }
                return {
                    imgCdn: img("imgCdn"), imgSelf: img("imgSelf"), scriptCdn: !!p["scriptCdn"], inlineNonce: !!p["inlineNonce"],
                    inlinePlain: !!p["inlinePlain"], styleCdn: !!link?.sheet, fetchCdn, boot: !!p["boot"],
                };
            }, { cdn: url.includes("/cyrano/") ? `${proxyOrigin}/cyrano/http/cdn.localhost:${port}/data.txt` : `${cdn}/data.txt` });
            await ctx.close();
            return out;
        };

        const mismatches: string[] = [];
        let weakened = 0;
        for (const policyValue of draws) {
            current = {
                policy: policyValue,
                translated: (await oracle.ask("csp", ["header", proxyOrigin, "_crnpolicy", policyValue])) ?? "",
                nonce: await oracle.ask("cspnonce", [policyValue]),
                inline: (await oracle.ask("cspinline", [policyValue])) === "yes",
            };
            const direct = await run(`http://a.localhost:${port}/page`);
            const proxied = await run(`${proxyOrigin}/cyrano/http/a.localhost:${port}/page`);
            for (const k of PROBES) {
                if (direct[k] && !proxied[k]) mismatches.push(`${k} loads directly, not proxied: ${JSON.stringify(policyValue)} → ${JSON.stringify(current.translated)}`);
                if (!direct[k] && proxied[k]) weakened++;
            }
            // Where no page script runs directly, the runtime's absence cannot
            // be seen ('strict-dynamic' with nothing to trust).
            const pageScripts = direct.scriptCdn || direct.inlineNonce || direct.inlinePlain;
            if (pageScripts && !proxied.boot) mismatches.push(`${JSON.stringify(policyValue)} → ${JSON.stringify(current.translated)}: the bootstrap did not run (nonce ${current.nonce}, inline ${current.inline})`);
        }
        console.log(`CSP: ${draws.length} policies, ${weakened} probes allowed only proxied (the weakening)`);
        expect(mismatches.slice(0, 25), `${mismatches.length} differ (chromium ${browser.version()})`).toEqual([]);
    }, 600_000);
});
