// @vitest-environment node
//
// spec/Cookies.agda's Cookie Store model against Chromium, through the
// runtime: the same random sequence of cookieStore set / delete / get /
// getAll calls runs on a page direct (https) and proxied; every answer —
// a refusal (type and message), each item (name, value, domain, path,
// sameSite, secure; expiry by kind), document.cookie after — must be
// the same. Google's ad tag stores its first-party cookies so (__gads),
// and every one was refused through the proxy (2026-11-19).
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`
// (and Google Chrome: `make chrome-check`).

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createSecureServer, type Server as SecureServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
// CYRANO_CHROME=1: in Google Chrome (`make chrome-check`), the earlier generation.
const chrome = process.env.CYRANO_CHROME === "1";
const wanted = (process.env.CYRANO_BROWSER === "1" || chrome) && existsSync(bundlePath);
const seed = Number(process.env.CYRANO_SEED ?? Date.now() % 1e9);

type Page = { goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T | Promise<T>, a: A): Promise<T>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(o?: object): Promise<Context>; close(): Promise<void> };

type Op = { op: "set" | "delete" | "get" | "getAll"; args: unknown[] };

const names = ["a", "sid", "__Host-x", "__host-l", "__Secure-y", "", "i s", "é", "sp ", "a;b", "t\tb", "n=m"];
const values = ["1", "", "v=w", "a b", "__Host-v", "x;y", " p"];
const domains = [undefined, "a.example.com", ".a.example.com", "www.a.example.com", "A.Example.COM", "b.example.com", "com", "example.com"];
const paths = [undefined, "/", "/x", "/x/", "x", "/x/y", "/q"];

const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.tuple(fc.constantFrom(...names), fc.constantFrom(...values)).map(([n, v]): Op => ({ op: "set", args: [n, v] })),
    fc.record({
        name: fc.constantFrom(...names), value: fc.constantFrom(...values), domain: fc.constantFrom(...domains),
        path: fc.constantFrom(...paths), sameSite: fc.constantFrom(undefined, "strict", "lax", "none"), expires: fc.constantFrom(undefined, null, -1, 1),
    }, { requiredKeys: ["name", "value"] }).map((o): Op => ({ op: "set", args: [o] })),
    fc.record({ name: fc.constantFrom(...names), domain: fc.constantFrom(...domains), path: fc.constantFrom(...paths) }, { requiredKeys: ["name"] })
        .map((o): Op => ({ op: "delete", args: [o] })),
    fc.constantFrom(...names).map((n): Op => ({ op: "get", args: [n] })),
    fc.constantFrom<Op>({ op: "getAll", args: [] }, { op: "get", args: [{}] }, { op: "getAll", args: [{ url: "/x/y/z" }] }, { op: "getAll", args: [{ url: "/other" }] }),
);

describe.skipIf(!wanted)("cookieStore in Chromium, direct and proxied", () => {
    let browser: Browser;
    let direct: SecureServer;
    let proxy: Server;
    let dport = 0, pport = 0;

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        const dir = mkdtempSync(join(tmpdir(), "crn-cs-"));
        execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=www.a.example.com", "-days", "2", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")], { stdio: "ignore" });
        direct = createSecureServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (_req, res) => {
            res.writeHead(200, { "content-type": "text/html" });
            res.end("<!doctype html>x");
        });
        await new Promise<void>((r) => direct.listen(0, "127.0.0.1", () => r()));
        dport = (direct.address() as { port: number }).port;
        proxy = createServer((req, res) => {
            if (req.url === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            const o = `http://127.0.0.1:${pport}`;
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return res.end(`<!doctype html><script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:${JSON.stringify(o)},source:"/rewriter.js"}).inject();$rewriter.set_location("https://www.a.example.com:${dport}/x/y/z");</script>x`);
        });
        await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
        pport = (proxy.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch({ ...(chrome ? { channel: "chrome" } : {}), args: ["--host-resolver-rules=MAP *.example.com 127.0.0.1"] });
    });
    afterAll(async () => {
        await browser?.close();
        direct?.close();
        proxy?.close();
    });

    const run = async (url: string, ops: Op[]): Promise<unknown[]> => {
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await ctx.newPage();
        await page.goto(url);
        const out = await page.evaluate(async (ops: Op[]) => {
            const res: unknown[] = [];
            const item = (i: Record<string, unknown> | null) => i && { ...i, expires: i["expires"] === null ? null : typeof i["expires"] };
            for (const { op, args } of ops) {
                const a = args.map((x) => (x && typeof x === "object" && "expires" in x && typeof (x as { expires: unknown }).expires === "number"
                    ? { ...x, expires: Date.now() + (x as { expires: number }).expires * 86400000 } : x));
                try {
                    const r = await (cookieStore as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>)[op]!(...a);
                    res.push(op === "getAll" ? (r as Record<string, unknown>[]).map(item) : op === "get" ? item(r as Record<string, unknown> | null) : r === undefined ? "ok" : r);
                } catch (e) {
                    res.push(`${(e as Error).constructor.name}: ${(e as Error).message}`);
                }
            }
            res.push(document.cookie);
            return res;
        }, ops);
        await ctx.close();
        return out;
    };

    it("answers as direct", async () => {
        const runs = fc.sample(fc.array(opArb, { minLength: 4, maxLength: 14 }), { numRuns: 12, seed });
        const bad: string[] = [];
        for (const ops of runs) {
            const d = await run(`https://www.a.example.com:${dport}/x/y/z`, ops);
            const p = await run(`http://127.0.0.1:${pport}/cyrano/https/www.a.example.com:${dport}/x/y/z`, ops);
            if (JSON.stringify(d) !== JSON.stringify(p)) {
                const k = d.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(p[i]));
                bad.push(`${JSON.stringify(ops.slice(0, k + 1))}\n  direct  ${JSON.stringify(d[k])}\n  proxied ${JSON.stringify(p[k])}`);
            }
        }
        expect(bad.slice(0, 6).join("\n"), `${bad.length} of ${runs.length} (seed ${seed})`).toBe("");
    }, 120_000);
});
