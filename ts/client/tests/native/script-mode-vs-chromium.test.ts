// @vitest-environment node
//
// A cross-origin script, in real Chromium, direct and through the real
// proxy, in the page's own mode (spec/Orb.agda proxyBlocks, corsFails).
// The browser asks the proxy in that mode — the runtimes leave a missing
// crossorigin missing — so the proxy fails what the browser would have:
// a no-cors script ORB blocks, whatever Access-Control-Allow-Origin it
// carries (snowball-io.io's HTML with ACAO: *, 2026-11-22: it ran proxied,
// a SyntaxError), and a cors-mode one (crossorigin, a module) the CORS
// check refuses (one with no ACAO ran proxied). Each script's load or
// error event, and whether it ran, as directly.
//
// Runs the server binary (go/assets/cyrano) on a free port. Needs it and
// Playwright's Chromium; `make browser-check`.

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

// name → [how the page loads it, what the other origin answers]
const CASES: Record<string, [string, { ct: string; acao?: string; body: string }]> = {
    htmlAcao: ["", { ct: "text/html", acao: "*", body: "<!doctype html><html><body>x</body></html>" }],
    jsonPlain: ["", { ct: "application/json", body: '{"a":1}' }],
    jsPlain: ["", { ct: "text/javascript", body: "window.ran.push('jsPlain')" }],
    jsCorsNoAcao: [" crossorigin", { ct: "text/javascript", body: "window.ran.push('jsCorsNoAcao')" }],
    jsCorsAcao: [" crossorigin", { ct: "text/javascript", acao: "*", body: "window.ran.push('jsCorsAcao')" }],
    jsCorsOther: [" crossorigin", { ct: "text/javascript", acao: "https://other.example", body: "window.ran.push('jsCorsOther')" }],
    moduleNoAcao: [' type="module"', { ct: "text/javascript", body: "window.ran.push('moduleNoAcao')" }],
    moduleAcao: [' type="module"', { ct: "text/javascript", acao: "*", body: "window.ran.push('moduleAcao')" }],
    htmlCorsAcao: [" crossorigin", { ct: "text/html", acao: "*", body: "<!doctype html><p>x" }],
    jsCorsSelf: ["-", { ct: "text/javascript", acao: "SELF", body: "" }], // the sandboxed frame's only
    // A module importing another origin's module whose ACAO names the page:
    // the import's Referer is the importing module, its origin the page's.
    moduleImports: [' type="module"', { ct: "text/javascript", acao: "*", body: "import 'http://localhost2/s?n=importedPageAcao'; window.ran.push('moduleImports')" }],
    importedPageAcao: ["-", { ct: "text/javascript", acao: "PAGE", body: "window.ran.push('importedPageAcao')" }],

};

describe.skipIf(!wanted)("a cross-origin script in the page's mode, in Chromium, through the proxy", () => {
    let browser: Browser;
    let upstream: Server;
    let proxy: ChildProcess;
    let port = 0;
    let proxyOrigin = "";

    beforeAll(async () => {
        upstream = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/sandboxed") {
                // A sandboxed document (origin "null"): its scripts on its own
                // URL's origin are cross-origin to it.
                const self = `http://127.0.0.1:${port}`;
                res.writeHead(200, { "content-type": "text/html" });
                return res.end(`<!doctype html><head><script>window.ev = [];</script>` +
                    `<script src="${self}/s?n=jsonPlain" onload="ev.push('jsonSelf:load')" onerror="ev.push('jsonSelf:error')"></script>` +
                    `<script crossorigin src="${self}/s?n=jsCorsSelf" onload="ev.push('corsSelf:load')" onerror="ev.push('corsSelf:error')"></script>` +
                    `<script crossorigin src="${self}/s?n=jsCorsAcao" onload="ev.push('corsStar:load')" onerror="ev.push('corsStar:error')"></script>` +
                    `<script>setTimeout(() => parent.postMessage(ev.sort().join(","), "*"), 800);</script></head><body>s</body>`);
            }
            if (u.pathname === "/p") {
                // The page on 127.0.0.1; its scripts on localhost (another origin).
                const tags = Object.entries(CASES).filter(([, [a]]) => a !== "-").map(([n, [attrs]]) =>
                    `<script${attrs} src="http://localhost:${port}/s?n=${n}" onload="window.ev.push('${n}:load')" onerror="window.ev.push('${n}:error')"></script>`).join("");
                res.writeHead(200, { "content-type": "text/html" });
                return res.end(`<!doctype html><head><script>window.ev = []; window.ran = []; window.onerror = () => true;` +
                    `addEventListener("message", (e) => { window.sandboxed = e.data; });</script>${tags}</head>` +
                    `<body>x<iframe sandbox="allow-scripts" src="/sandboxed"></iframe></body>`);
            }
            const c = CASES[u.searchParams.get("n") ?? ""];
            if (!c) { res.writeHead(404); return res.end(); }
            const h: Record<string, string> = { "content-type": c[1].ct };
            if (c[1].acao) h["access-control-allow-origin"] = c[1].acao === "SELF" || c[1].acao === "PAGE" ? `http://127.0.0.1:${port}` : c[1].acao;
            res.writeHead(200, h);
            return res.end(c[1].body.replace("http://localhost2/", `http://127.0.0.2:${port}/`));
        });
        await new Promise<void>((r) => upstream.listen(0, "0.0.0.0", () => r()));
        port = (upstream.address() as { port: number }).port;
        const pport = await free();
        proxyOrigin = `http://localhost:${pport}`;
        proxy = spawn(binary, ["--assets", resolve(root, "go/assets"), "--log-level", "warn"], {
            env: { ...process.env, CYRANO_PUBLIC_URL: proxyOrigin, CYRANO_PORT: String(pport), CYRANO_HOSTNAME: "localhost", CYRANO_HTTPS_ENABLED: "false" },
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

    const run = async (url: string): Promise<{ ev: string[]; ran: string[]; sandboxed: string }> => {
        const page = await browser.newPage();
        await page.goto(url);
        await page.evaluate(() => new Promise((res) => setTimeout(res, 2500)));
        const out = await page.evaluate(() => {
            const w = window as unknown as { ev: string[]; ran: string[]; sandboxed: string };
            return { ev: [...w.ev].sort(), ran: [...w.ran].sort(), sandboxed: w.sandboxed };
        });
        await page.close();
        return out;
    };

    it("each script loads or fails as directly", async () => {
        const direct = await run(`http://127.0.0.1:${port}/p`);
        const proxied = await run(`${proxyOrigin}/cyrano/http/127.0.0.1:${port}/p`);
        // What Chromium does (measured): ORB and the CORS check.
        expect(direct.ran).toContain("importedPageAcao");
        expect(direct.ev).toEqual(["htmlAcao:error", "htmlCorsAcao:load", "jsCorsAcao:load", "jsCorsNoAcao:error", "jsCorsOther:error",
            "jsPlain:load", "jsonPlain:error", "moduleAcao:load", "moduleImports:load", "moduleNoAcao:error"]);
        // In a sandboxed document (origin "null") even its own URL's origin
        // is another: ORB blocks the JSON, ACAO naming that origin fails.
        expect(direct.sandboxed).toBe("corsSelf:error,corsStar:load,jsonSelf:error");
        expect(proxied).toEqual(direct);
    }, 60_000);
});
