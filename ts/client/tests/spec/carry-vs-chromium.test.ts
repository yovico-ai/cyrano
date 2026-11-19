// @vitest-environment node
//
// spec/Carry.agda against Chromium: a header value written byte for byte
// into Crn-H (`crnh`) parses back to exactly what fetch shows for the
// header itself — a script's native view, one character per byte; a crnb
// Server-Timing metric reaches the performance entry with the description
// as written, which the spec reads as the sizes (`crnbread`).
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server, type Socket } from "node:net";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";
const seed = Number(process.env.CYRANO_SEED ?? Date.now() % 1e9);

type Page = { goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T | Promise<T>, a: A): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

describe.skipIf(!wanted || located.skip !== "")("Carry: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;
    const responses: Buffer[] = [];

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        // A raw server: header values go on the wire byte for byte.
        server = createServer((sock: Socket) => {
            let buf = "";
            sock.on("data", (d) => {
                buf += d.toString("latin1");
                if (buf.indexOf("\r\n\r\n") < 0) return;
                const target = buf.split(" ")[1] ?? "/";
                buf = "";
                const k = Number(/case=(\d+)/.exec(target)?.[1] ?? -1);
                const head = k >= 0 ? responses[k]! : Buffer.from("Content-Type: text/html\r\n", "latin1");
                const body = k >= 0 ? "ok" : "<!doctype html><title>p</title>";
                sock.end(Buffer.concat([Buffer.from("HTTP/1.1 200 OK\r\n", "latin1"), head,
                    Buffer.from(`Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`, "latin1")]));
            });
            sock.on("error", () => {});
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

    it("a Crn-H value parses to the header as fetch shows it; a crnb description is as written", async () => {
        // Header bytes: printable, high, tab; not CR, LF, NUL (they end or break a field).
        const byte = fc.oneof(fc.integer({ min: 0x20, max: 0xff }), fc.constant(9)).map((n) => String.fromCharCode(n));
        const value = fc.array(byte, { minLength: 1, maxLength: 10 }).map((a) => a.join("")).filter((v) => v.trim() === v && v.trim() !== "");
        const draws = fc.sample(fc.tuple(value, fc.nat(99999), fc.nat(99999)), { numRuns: 120, seed });
        responses.length = 0;
        const expected: { crn: string; sizes: string }[] = [];
        for (const [v, e, d] of draws) {
            // (The value may hold a tab, which the crnh request format splits on.)
            const crn = `{"x-a":[${(await oracle.ask("jsonbytes", [v]))!}]}`;
            const desc = `${e}-${d}`;
            responses.push(Buffer.from(`Content-Type: text/plain\r\nX-A: ${v}\r\nCrn-H: ${crn}\r\nServer-Timing: crnb;desc="${desc}"\r\nTiming-Allow-Origin: *\r\n`, "latin1"));
            expected.push({ crn, sizes: (await oracle.ask("crnbread", [desc]))! });
        }
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${port}/`);
        const got = await page.evaluate(async (n: number) => {
            const out: { header: string | null; carried: string | null; desc: string | null }[] = [];
            for (let k = 0; k < n; k++) {
                const url = `/r?case=${k}`;
                const r = await fetch(url, { cache: "no-store" });
                await r.text();
                const entry = performance.getEntriesByName(new URL(url, location.href).href).pop() as PerformanceResourceTiming | undefined;
                let carried: string | null = null;
                try { carried = (JSON.parse(r.headers.get("crn-h") ?? "null") as Record<string, string[]>)["x-a"]![0]!; } catch { carried = null; }
                out.push({ header: r.headers.get("x-a"), carried, desc: entry?.serverTiming.find((m) => m.name === "crnb")?.description ?? null });
            }
            return out;
        }, draws.length);
        await page.close();
        const bad: string[] = [];
        for (let k = 0; k < draws.length; k++) {
            const [v, e, d] = draws[k]!;
            if (got[k]!.carried !== got[k]!.header) bad.push(`${JSON.stringify(v)}: fetch shows ${JSON.stringify(got[k]!.header)}, Crn-H gives ${JSON.stringify(got[k]!.carried)}`);
            if (got[k]!.desc !== `${e}-${d}` || expected[k]!.sizes !== `${e} ${d}`) bad.push(`crnb ${e}-${d}: entry ${got[k]!.desc}, spec ${expected[k]!.sizes}`);
        }
        expect(bad.slice(0, 10), `${bad.length} (seed ${seed})`).toEqual([]);
    }, 120_000);
});
