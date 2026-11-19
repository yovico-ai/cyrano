// @vitest-environment node
//
// spec/FetchLater.agda against Chromium: random sequences of fetchLater
// calls to one origin, with random URLs, headers and bodies, are admitted
// or refused (QuotaExceededError, its message) as `fetchlatersize` and
// `fetchlateradmit` say, counting only what was admitted; another origin
// has a quota of its own.
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";
import { BODIES, HEADERS, sizeArgs, type BodyKind } from "./fetch-later-cases";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";
const seed = Number(process.env.CYRANO_SEED ?? Date.now() % 1e9);

type Page = { goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T | Promise<T>, a: A): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

describe.skipIf(!wanted || located.skip !== "")("fetchLater quota: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html>x"); });
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

    it("admitted or refused as the spec says", async () => {
        const call = fc.record({ other: fc.boolean(), path: fc.constantFrom("/", "/p?q=1#frag", "/x/" + "y".repeat(200), "/é?ü#x"), headers: fc.constantFrom(...HEADERS), kind: fc.constantFrom(...BODIES), n: fc.oneof({ arbitrary: fc.constant(0), weight: 1 }, { arbitrary: fc.nat(16000), weight: 6 }) });
        const runs = fc.sample(fc.array(call, { minLength: 12, maxLength: 30 }), { numRuns: 12, seed });
        const bad: string[] = [];
        let refused = 0;
        for (const calls of runs) {
            const page = await browser.newPage();
            await page.goto(`http://localhost:${port}/`);
            const reqs = calls.map((c) => ({ ...c, url: `http://${c.other ? "127.0.0.1" : "localhost"}:${port}${c.path}` }));
            const got = await page.evaluate((rs: typeof reqs) => rs.map((r) => {
                const k = r.kind;
                const body = k === "none" ? undefined : k === "text" ? "é€😀x".repeat(r.n >> 2) : k === "params" ? new URLSearchParams({ k: "v w".repeat(r.n) })
                    : k === "blob" ? new Blob(["x".repeat(r.n)]) : k === "typed-blob" ? new Blob(["x".repeat(r.n)], { type: "Text/Weird" })
                        : k === "buffer" ? new ArrayBuffer(r.n) : new Uint16Array(r.n);
                const init: Record<string, unknown> = { headers: r.headers, activateAfter: 3600000 };
                if (body !== undefined) { init["method"] = "POST"; init["body"] = body; }
                try { (window as unknown as { fetchLater(u: string, i: object): unknown }).fetchLater(r.url, init); return "ok"; } catch (e) { return `${(e as Error).name}: ${(e as Error).message}`; }
            }), reqs);
            await page.close();
            const used = new Map<boolean, number>();
            for (let i = 0; i < reqs.length; i++) {
                const r = reqs[i]!;
                const sized = (await oracle.ask("fetchlatersize", sizeArgs(r.url, r.headers, r.kind as BodyKind, r.n)))!;
                if (sized === "unknown-length") {
                    if (got[i] !== "TypeError: Failed to execute 'fetchLater' on 'Window': fetchLater doesn't support body with unknown length.") bad.push(`#${i} ${r.url} ${r.kind} ${r.n}: Chromium ${got[i]}, spec a TypeError (unknown length)`);
                    continue;
                }
                const size = Number(sized);
                const before = used.get(r.other) ?? 0;
                const verdict = (await oracle.ask("fetchlateradmit", [String(before), String(size)]))!;
                const want = verdict === "ok" ? "ok" : `QuotaExceededError: ${verdict}`;
                if (verdict === "ok") used.set(r.other, before + size); else refused++;
                if (got[i] !== want) bad.push(`#${i} ${r.url} ${r.kind} ${r.n} ${JSON.stringify(r.headers)}: Chromium ${got[i]}, spec ${want}`);
            }
        }
        expect(bad.slice(0, 10), `${bad.length} (seed ${seed})`).toEqual([]);
        expect(refused).toBeGreaterThan(3);
    }, 120_000);
});
