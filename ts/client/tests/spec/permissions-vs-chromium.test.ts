// @vitest-environment node
//
// spec/Permissions.agda against Chromium: a document served with a
// Permissions-Policy header is told by document.featurePolicy what the spec
// says (`ppallows`), for itself and for other origins — under the header
// as written and under its translation (`pptranslate`), which is what a
// proxied document is given.
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

// Features with their default allowlist (* or self).
const FEATURES: [string, boolean][] = [["geolocation", false], ["camera", false], ["fullscreen", false], ["sync-xhr", true], ["picture-in-picture", true]];
const OTHERS = ["http://127.0.0.1:1", "https://a.example", "https://b.a.example", "https://a.example:8443"];

describe.skipIf(!wanted || located.skip !== "")("Permissions-Policy: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;
    const served = new Map<string, string[]>();

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req, res) => {
            const lines = served.get(req.url ?? "") ?? [];
            if (lines.length > 0) res.setHeader("Permissions-Policy", lines);
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

    it("featurePolicy under a header and under its translation", async () => {
        const doc = `http://localhost:${port}`;
        const key = fc.constantFrom(...FEATURES.map(([f]) => f), "geolocation", "x-unknown", "Geolocation", "camera");
        const member = fc.constantFrom("*", "self", "src", "?1", "1", `"https://a.example"`, `"${doc}"`, `"https://*.a.example"`, `"https://a.example:8443/p"`,
            `"not a url"`, `"data:x"`, `"*"`, `"self"`, `"src"`, `"'self'"`, `"'none'"`, `"'src'"`, `"'self"`, "self;a=1", "i.dell.com", `"http://u@localhost:${port}"`, `"http://u:p@127.0.0.1:1"`, "https://a.example", "localhost");
        const value = fc.oneof(member, fc.array(member, { maxLength: 3 }).map((ms) => `(${ms.join(" ")})`), fc.constant(""));
        const entry = fc.tuple(key, value).map(([k, v]) => (v === "" ? k : `${k}=${v}`));
        const line = fc.tuple(fc.array(entry, { minLength: 1, maxLength: 4 }), fc.constantFrom(", ", ",", " , ", ",, ")).map(([es, sep]) => es.join(sep));
        const draws = fc.sample(fc.array(line, { minLength: 1, maxLength: 2 }), { numRuns: 150, seed });
        const bad: string[] = [];
        const page = await browser.newPage();
        let n = 0;
        for (const lines of draws) {
            const translated = (await oracle.ask("pptranslate", [lines.join("\n")]))!.split("\n");
            for (const [kind, ls] of [["direct", lines], ["translated", translated]] as const) {
                const path = `/d${n++}`;
                served.set(path, ls);
                await page.goto(`${doc}${path}`);
                const got = await page.evaluate(({ fs, os }: { fs: string[]; os: string[] }) => {
                    const fp = (document as unknown as { featurePolicy: { allowsFeature(f: string, o?: string): boolean } }).featurePolicy;
                    return fs.map((f) => [fp.allowsFeature(f), ...os.map((o) => fp.allowsFeature(f, o))]);
                }, { fs: FEATURES.map(([f]) => f), os: OTHERS });
                for (let i = 0; i < FEATURES.length; i++) {
                    const [f, def] = FEATURES[i]!;
                    for (let j = 0; j <= OTHERS.length; j++) {
                        const o = j === 0 ? doc : OTHERS[j - 1]!;
                        const want = (await oracle.ask("ppallows", [ls.join("\n"), f, def ? "1" : "0", doc, o])) === "yes";
                        if (got[i]![j] !== want) bad.push(`${kind} ${JSON.stringify(ls)} ${f} for ${o}: Chromium ${got[i]![j]}, spec ${want}`);
                    }
                }
            }
        }
        await page.close();
        expect(bad.slice(0, 12), `${bad.length} (seed ${seed})`).toEqual([]);
    }, 600_000);
});
