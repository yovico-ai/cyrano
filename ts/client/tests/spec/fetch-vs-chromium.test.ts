// @vitest-environment node
//
// "The spec is the browser", for a page's cross-origin fetch: whether the
// request carries credentials, whether its response passes the CORS check,
// and which response headers the script then sees, as spec/Fetch.agda says
// (`credentials`, `cors`, `expose`), must be what real Chromium does
// natively. A page on a.localhost fetches from b.localhost; the response's
// header lines are written raw (repeated lines, odd whitespace) by a TCP
// server, so the browser sees exactly the draw.
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server, type Socket } from "node:net";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T, a: A): Promise<T>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void>; version(): string };

// Response headers every draw sends besides the CORS ones; the script's
// view of them is what `expose` decides.
const SHOWN = ["x-foo", "x-bar", "content-language", "x-star"];

interface Draw {
    mode: "omit" | "same-origin" | "include";
    acao: string[];
    acac: string[];
    expose: string[];
}

describe.skipIf(!wanted || located.skip !== "")("fetch / CORS: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;
    const draws: Draw[] = [];

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((sock: Socket) => {
            let buf = "";
            sock.on("data", (d) => {
                buf += d.toString("latin1");
                const end = buf.indexOf("\r\n\r\n");
                if (end < 0) return;
                const head = buf.slice(0, end);
                buf = "";
                const target = head.split(" ")[1] ?? "/";
                const host = /\r\nhost:\s*([^\r\n]*)/i.exec(head)?.[1] ?? "";
                let lines: string[];
                let body: string;
                if (host.startsWith("a.localhost")) {
                    lines = ["Content-Type: text/html"];
                    body = "<!doctype html><title>a</title>";
                } else {
                    const d = draws[Number(/case=(\d+)/.exec(target)?.[1] ?? -1)];
                    lines = ["Content-Type: text/plain", "X-Foo: 1", "X-Bar: 2", "Content-Language: en", "X-Star: 3"];
                    if (d) {
                        for (const v of d.acao) lines.push(`Access-Control-Allow-Origin:${v}`);
                        for (const v of d.acac) lines.push(`Access-Control-Allow-Credentials:${v}`);
                        for (const v of d.expose) lines.push(`Access-Control-Expose-Headers:${v}`);
                    }
                    body = "ok";
                }
                sock.end(Buffer.from(`HTTP/1.1 200 OK\r\n${lines.join("\r\n")}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`, "latin1"));
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

    it("a RequestInit's referrer is read as Chromium reads it (spec initref)", async () => {
        const origin = `http://a.localhost:${port}`;
        const pieces = ["", "about:client", "ABOUT:CLIENT", "about:blank", "/x", "x#h", "../up?q", `${origin}/y`, `${origin}`, "http://b.localhost/",
            `https://a.localhost:${port}/`, `http://a.localhost:${port + 1}/`, "data:,x", "javascript:1", " /sp", "http://[", "//a.localhost:" + port + "/n",
            "?only", "#only", "%zz", "\\back"];
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(`${origin}/dir/page?q=1#f`);
        const got = await page.evaluate((vs: string[]) => vs.map((v) => {
            try { return new Request("/t", { referrer: v }).referrer; } catch (e) { return (e as Error).name; }
        }), pieces);
        await ctx.close();
        const bad: string[] = [];
        for (let k = 0; k < pieces.length; k++) {
            const want = await oracle.ask("initref", [`${origin}/dir/page?q=1#f`, `${origin}/dir/page?q=1#f`, pieces[k]!]);
            if (want !== got[k]) bad.push(`${JSON.stringify(pieces[k])}: Chromium ${JSON.stringify(got[k])}, spec ${JSON.stringify(want)}`);
        }
        expect(bad).toEqual([]);
    });

    it("credentials, the CORS check and the exposed headers are Chromium's", async () => {
        const origin = `http://a.localhost:${port}`;
        // A field value as written after "Name:" (the leading space is ours).
        const acaoValues = [" *", ` ${origin}`, `  ${origin}  `, `\t${origin}`, ` ${origin}/`, ` http://A.localhost:${port}`,
            " null", " ", ` *, ${origin}`, ` ${origin}, ${origin}`];
        const acacValues = [" true", " True", "  true\t", " false", " ", " true, true"];
        const exposeValues = [" *", " X-Foo", " x-foo, x-bar", " X-FOO , *", "\tx-bar\t", " X-Foo X-Bar", " x-foo,,x-bar",
            " \u000bx-foo", " x-foo\u000b", " set-cookie", " ,", " x-star;q=1", " \"x-foo\""];
        const draw = fc.record({
            mode: fc.constantFrom<Draw["mode"]>("omit", "same-origin", "include"),
            acao: fc.array(fc.constantFrom(...acaoValues), { maxLength: 2 }),
            acac: fc.array(fc.constantFrom(...acacValues), { maxLength: 2 }),
            expose: fc.array(fc.constantFrom(...exposeValues), { maxLength: 2 }),
        });
        draws.push(...fc.sample(draw, { numRuns: 200, seed: Number(process.env.CYRANO_SEED ?? Date.now() % 1e9) }));

        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(`${origin}/`);
        const native = await page.evaluate(async (a: { n: number; port: number; modes: string[] }) => {
            const out: (string[] | null)[] = [];
            for (let i = 0; i < a.n; i++) {
                try {
                    const r = await fetch(`http://b.localhost:${a.port}/api?case=${i}`, { credentials: a.modes[i] as RequestCredentials, cache: "no-store" });
                    out.push([...r.headers.keys()]);
                } catch {
                    out.push(null);
                }
            }
            return out;
        }, { n: draws.length, port, modes: draws.map((d) => d.mode) });
        await ctx.close();

        const lines = (vs: string[]) => vs.map((v) => v.slice(0)).join("\n");
        const mismatches: string[] = [];
        for (let i = 0; i < draws.length; i++) {
            const d = draws[i]!;
            const cred = (await oracle.ask("credentials", [d.mode, "cross"])) === "yes";
            const passes = (await oracle.ask("cors", [origin, cred ? "cred" : "nocred", lines(d.acao), lines(d.acac)])) === "yes";
            const got = native[i];
            const label = JSON.stringify(d);
            if (passes !== (got !== null)) {
                mismatches.push(`${label}: spec ${passes ? "passes" : "fails"}, chromium ${got === null ? "fails" : "passes"}`);
                continue;
            }
            if (!got) continue;
            for (const name of SHOWN) {
                const shown = (await oracle.ask("expose", [cred ? "cred" : "nocred", lines(d.expose), name])) === "yes";
                if (shown !== got.includes(name)) mismatches.push(`${label} ${name}: spec ${shown ? "shown" : "hidden"}, chromium ${got.includes(name) ? "shown" : "hidden"}`);
            }
        }
        expect(mismatches.slice(0, 25), `${mismatches.length} differ (chromium ${browser.version()})`).toEqual([]);
    }, 300_000);
});
