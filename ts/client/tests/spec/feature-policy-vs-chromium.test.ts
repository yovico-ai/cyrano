// @vitest-environment node
//
// spec/Allow.agda fpAllows against Chromium: a document served with a
// Feature-Policy header (sometimes beside a Permissions-Policy) is told by
// document.featurePolicy what the spec says (`fpallows`), for itself and
// for other origins — as written, and translated as the proxy gives it
// (`fprewrite`, `pptranslate`).
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";
const seed = Number(process.env.CYRANO_SEED ?? Date.now() % 1e9);

type Page = { goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T, a: A): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const FEATURES: [string, boolean][] = [["geolocation", false], ["camera", false], ["fullscreen", false], ["sync-xhr", true], ["picture-in-picture", true]];
const OTHERS = ["http://127.0.0.1:1", "https://a.example", "https://b.a.example"];

describe.skipIf(!wanted || located.skip !== "")("Feature-Policy: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;
    const served = new Map<string, { fp: string; pp: string }>();

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req, res) => {
            const c = served.get(req.url ?? "");
            if (c) {
                res.setHeader("Feature-Policy", c.fp);
                if (c.pp !== "") res.setHeader("Permissions-Policy", c.pp);
            }
            res.setHeader("Content-Type", "text/html");
            res.end("<!doctype html><title>p</title>");
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

    it("featurePolicy under Feature-Policy, with and without Permissions-Policy, and translated", async () => {
        const doc = `http://localhost:${port}`;
        const feature = fc.constantFrom(...FEATURES.map(([f]) => f), "Camera", "x-unknown");
        const word = fc.constantFrom("*", "'self'", "'SELF'", "'src'", "'none'", "self", "junk", "https://a.example", `${doc}/p`, "https://*.a.example", "data:x", "http://u@127.0.0.1:1");
        const directive = fc.tuple(feature, fc.array(word, { maxLength: 3 })).map(([f, ws]) => [f, ...ws].join(" "));
        const fpv = fc.tuple(fc.array(directive, { minLength: 1, maxLength: 3 }), fc.constantFrom("; ", ";", ";; ")).map(([ds, sep]) => ds.join(sep));
        const ppv = fc.constantFrom("", "", "camera=()", "geolocation=*, fullscreen=(self)", "sync-xhr=()", "Camera=()", `fullscreen=("https://a.example")`);
        const draws = fc.sample(fc.tuple(fpv, ppv), { numRuns: 100, seed });
        const bad: string[] = [];
        const page = await browser.newPage();
        let n = 0;
        for (const [fp, pp] of draws) {
            const tfp = (await oracle.ask("fprewrite", [fp]))!;
            const tpp = pp === "" ? "" : (await oracle.ask("pptranslate", [pp]))!;
            for (const [kind, f1, p1] of [["direct", fp, pp], ["translated", tfp, tpp]] as const) {
                const path = `/d${n++}`;
                served.set(path, { fp: f1, pp: p1 });
                await page.goto(`${doc}${path}`);
                const got = await page.evaluate(({ fs, os }: { fs: string[]; os: string[] }) => {
                    const p = (document as unknown as { featurePolicy: { allowsFeature(f: string, o?: string): boolean } }).featurePolicy;
                    return fs.map((f) => [p.allowsFeature(f), ...os.map((o) => p.allowsFeature(f, o))]);
                }, { fs: FEATURES.map(([f]) => f), os: OTHERS });
                for (let i = 0; i < FEATURES.length; i++) {
                    const [f, def] = FEATURES[i]!;
                    for (let j = 0; j <= OTHERS.length; j++) {
                        const o = j === 0 ? doc : OTHERS[j - 1]!;
                        const want = (await oracle.ask("fpallows", [p1, f1, f, def ? "1" : "0", doc, o])) === "yes";
                        if (got[i]![j] !== want) bad.push(`${kind} FP ${JSON.stringify(f1)} PP ${JSON.stringify(p1)} ${f} for ${o}: Chromium ${got[i]![j]}, spec ${want}`);
                    }
                }
            }
        }
        await page.close();
        expect(bad.slice(0, 12), `${bad.length} (seed ${seed})`).toEqual([]);
    }, 600_000);
});
