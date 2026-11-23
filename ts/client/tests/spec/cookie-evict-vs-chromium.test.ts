// @vitest-environment node
//
// spec/CookieJar.agda's eviction against Chromium: random runs of writes to
// one site — new cookies and rewrites, Secure or not, of each Priority —
// past its 180, through document.cookie; the cookies left must be those the
// spec's jar keeps (the `jar` op, the same writes as a script's). Chromium
// purges to 150 by priority-aware LRU with secure protection.
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T | Promise<T>, a: A): Promise<T> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };

const US = "\u001f";

function runs(n: number): string[][] {
    let seed = 5;
    const rnd = (k: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
    const out: string[][] = [];
    for (let r = 0; r < n; r++) {
        const writes: string[] = [];
        const total = 175 + rnd(60);
        let made = 0;
        for (let i = 0; i < total; i++) {
            // Mostly new cookies; some rewrites of earlier ones.
            const name = made > 0 && rnd(5) === 0 ? `c${rnd(made)}` : `c${made++}`;
            const attrs = ["", "; secure", "; priority=low", "; priority=high", "; secure; priority=low", "; secure; priority=high"][rnd(6)];
            writes.push(`${name}=${i}; max-age=9999${attrs}`);
        }
        out.push(writes);
    }
    return out;
}

describe.skipIf(!wanted || located.skip !== "")("a site's cookies past its limit: the spec's jar is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>e</title>"); });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
        oracle?.close();
    });

    it("keeps what the spec keeps", async () => {
        const url = `http://a.site.localhost:${port}/`;
        const bad: string[] = [];
        for (const writes of runs(12)) {
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            await page.goto(url);
            const native = await page.evaluate((ws: string[]) => {
                for (const w of ws) document.cookie = w;
                return document.cookie.split("; ").map((kv) => kv.split("=")[0]!).sort();
            }, writes);
            await ctx.close();
            // The same writes as a script's, one second apart (the jar's
            // order is its own tick; the minute threshold never comes up).
            const script = writes.map((w, i) => ["put", "api", String(1795000000000 + i * 1000), "site.localhost", url, w].join(US)).join("\n");
            const out = (await oracle.ask("jar", [script])) ?? "";
            const kept = out.split("\n").filter((l) => l.startsWith("E" + US)).map((l) => l.split(US)[1]!.split("!")[3]!).sort();
            if (JSON.stringify(kept) !== JSON.stringify(native)) {
                const onlyN = native.filter((x) => !kept.includes(x)), onlyS = kept.filter((x) => !native.includes(x));
                bad.push(`${writes.length} writes: Chromium keeps ${native.length}, spec ${kept.length}; only Chromium ${onlyN.slice(0, 8)}, only spec ${onlyS.slice(0, 8)}`);
            }
        }
        expect(bad).toEqual([]);
    }, 600_000);
});
