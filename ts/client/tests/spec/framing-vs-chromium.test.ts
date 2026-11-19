// @vitest-environment node
//
// "The spec is the browser", for framing: whether a document may be framed
// by an embedder, as spec/Csp.agda says (`frameanc`, else `xfo`), must be
// what real Chromium does natively. Embedders on several origins (the
// document's own, a subdomain, another host, another port) frame the
// document under drawn Content-Security-Policy frame-ancestors and
// X-Frame-Options headers; a frame that loads says so by postMessage.
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T, a: A): Promise<T>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void>; version(): string };

interface Draw { csp: string | null; xfo: string[] }

describe.skipIf(!wanted || located.skip !== "")("framing: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    const servers: Server[] = [];
    let p1 = 0, p2 = 0;
    const draws: Draw[] = [];
    // Frames that rendered: their document asked for its image ("embedder|case").
    const seen = new Set<string>();

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        const handler = (req: IncomingMessage, res: ServerResponse) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/embed") {
                const n = Number(u.searchParams.get("n"));
                const emb = encodeURIComponent(`http://${req.headers.host}`);
                const frames = Array.from({ length: n }, (_, i) => `<iframe src="http://doc.localhost:${p1}/doc?case=${i}&emb=${emb}"></iframe>`).join("");
                res.writeHead(200, { "content-type": "text/html" });
                res.end(`<!doctype html>${frames}`);
                return;
            }
            if (u.pathname === "/seen.png") {
                seen.add(`${u.searchParams.get("emb")}|${u.searchParams.get("case")}`);
                res.writeHead(204); res.end();
                return;
            }
            if (u.pathname === "/doc") {
                const d = draws[Number(u.searchParams.get("case"))];
                const headers: [string, string][] = [["content-type", "text/html"]];
                if (d?.csp != null) headers.push(["content-security-policy", d.csp]);
                for (const v of d?.xfo ?? []) headers.push(["x-frame-options", v]);
                res.writeHead(200, headers.flat() as unknown as Record<string, string>);
                // An image, not a script: the drawn policies never restrict images.
                res.end(`<!doctype html><img src="/seen.png?case=${u.searchParams.get("case")}&emb=${encodeURIComponent(u.searchParams.get("emb") ?? "")}">`);
                return;
            }
            res.writeHead(404); res.end();
        };
        for (let i = 0; i < 2; i++) {
            const s = createServer(handler);
            await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
            servers.push(s);
        }
        p1 = (servers[0]!.address() as { port: number }).port;
        p2 = (servers[1]!.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        oracle?.close();
        await browser?.close();
        for (const s of servers) s.close();
    });

    it("frame-ancestors and X-Frame-Options decide as in Chromium", async () => {
        const sources = ["'self'", "'none'", "*", "http:", "https:", "ws:", "data:", "doc.localhost", "a.localhost", "*.localhost", "*.a.localhost",
            `http://a.localhost:${p1}`, `http://a.localhost:${p2}`, `a.localhost:${p1}`, "http://a.localhost:*", `http://a.localhost:${p1}/`,
            `http://a.localhost:${p1}/x`, "https://a.localhost", "HTTP://A.LOCALHOST:*", `b.localhost:${p1}`, `http://*.localhost:${p1}`, "'unsafe-inline'"];
        const fa = fc.array(fc.constantFrom(...sources), { maxLength: 3 }).map((vs) => ["frame-ancestors", ...vs].join(" "));
        const policy = fc.tuple(fc.constantFrom("", "script-src *; "), fa, fc.constantFrom("", "; frame-ancestors *")).map(([a, b, c]) => a + b + c);
        const csp = fc.oneof(fc.constant(null), fc.constant("script-src *"), policy,
            fc.tuple(policy, policy).map(([a, b]) => `${a}, ${b}`));
        const xfo = fc.array(fc.constantFrom("DENY", "SAMEORIGIN", "sameorigin", " deny ", "ALLOWALL", "ALLOW-FROM http://a.localhost", "bogus", "", "SAMEORIGIN, DENY", "sameorigin,sameorigin"), { maxLength: 2 });
        draws.push(...fc.sample(fc.record({ csp, xfo }), { numRuns: 150, seed: Number(process.env.CYRANO_SEED ?? Date.now() % 1e9) }));

        const embedders = [`http://doc.localhost:${p1}`, `http://a.localhost:${p1}`, `http://sub.a.localhost:${p1}`, `http://b.localhost:${p1}`, `http://a.localhost:${p2}`];
        const docURL = `http://doc.localhost:${p1}/doc`;
        const mismatches: string[] = [];
        for (const emb of embedders) {
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            await page.goto(`${emb}/embed?n=${draws.length}`);
            await new Promise((r) => setTimeout(r, 2500));
            await ctx.close();
            for (let i = 0; i < draws.length; i++) {
                const d = draws[i]!;
                let allowed: boolean;
                const v = d.csp === null ? null : await oracle.ask("frameanc", [d.csp, `${emb}/`, docURL]);
                if (v !== null) allowed = v === "allow";
                else allowed = (await oracle.ask("xfo", [d.xfo.join("\n"), emb === `http://doc.localhost:${p1}` ? "same" : "cross"])) === "yes";
                const rendered = seen.has(`${emb}|${i}`);
                if (allowed !== rendered) mismatches.push(`${emb} ${JSON.stringify(d)}: spec ${allowed ? "allows" : "blocks"}, chromium ${rendered ? "allows" : "blocks"}`);
            }
        }
        expect(mismatches.slice(0, 30), `${mismatches.length} differ (chromium ${browser.version()})`).toEqual([]);
    }, 300_000);
});
