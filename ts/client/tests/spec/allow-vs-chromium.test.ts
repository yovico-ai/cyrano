// @vitest-environment node
//
// spec/Allow.agda against Chromium: a frame embedded with an allow
// attribute is told by its document.featurePolicy what the spec says
// (`allowframe`) — cross-origin with the attribute as written (direct), and
// same-origin with its translation (`allowrewrite`), as through the proxy,
// where the frame's src is a proxy URL.
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

type Frame = { url(): string; evaluate<T, A>(f: (a: A) => T, a: A): Promise<T> };
type Page = { goto(u: string): Promise<unknown>; frames(): Frame[]; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const FEATURES: [string, boolean][] = [["geolocation", false], ["camera", false], ["fullscreen", false], ["sync-xhr", true], ["picture-in-picture", true]];

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

describe.skipIf(!wanted || located.skip !== "")("iframe allow: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;
    const cases = new Map<string, { allow: string; src: string }>();

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req, res) => {
            const u = req.url ?? "";
            res.setHeader("Content-Type", "text/html");
            const c = cases.get(u);
            res.end(c ? `<!doctype html><iframe allow="${esc(c.allow)}" src="${c.src}"></iframe>` : "<!doctype html><title>frame</title>");
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

    it("the frame's featurePolicy, direct and translated", async () => {
        const parent = `http://localhost:${port}`;
        const other = `http://127.0.0.1:${port}`;
        const feature = fc.constantFrom(...FEATURES.map(([f]) => f), "Camera", "FULLSCREEN", "x-unknown");
        const word = fc.constantFrom("*", "'self'", "'src'", "'none'", "'SELF'", "self", "src", other, `${other}/p?q`, parent, "https://a.example", "junk", "data:x", `http://u@127.0.0.1:${port}`);
        const ws = fc.constantFrom(" ", "  ", "\t", "\n");
        const directive = fc.tuple(fc.constantFrom("", " "), feature, fc.array(fc.tuple(ws, word), { maxLength: 3 }))
            .map(([lead, f, items]) => lead + f + items.map(([w, i]) => w + i).join(""));
        const attr = fc.tuple(fc.array(directive, { minLength: 1, maxLength: 3 }), fc.constantFrom("; ", ";", ";;", " ; ")).map(([ds, sep]) => ds.join(sep));
        const draws = fc.sample(attr, { numRuns: 80, seed });
        const page = await browser.newPage();
        const bad: string[] = [];
        let n = 0;
        for (const allow of draws) {
            const translated = (await oracle.ask("allowrewrite", [allow]))!;
            for (const [kind, a, frameOrigin] of [["direct", allow, other], ["translated", translated, parent]] as const) {
                const path = `/parent${n++}`;
                cases.set(path, { allow: a, src: `${frameOrigin}/frame${n}` });
                await page.goto(`${parent}${path}`);
                const frame = page.frames().find((f) => f.url().includes(`/frame${n}`));
                if (!frame) { bad.push(`${kind} ${JSON.stringify(a)}: no frame`); continue; }
                const got = await frame.evaluate((fs: string[]) => {
                    const fp = (document as unknown as { featurePolicy: { allowsFeature(f: string): boolean } }).featurePolicy;
                    return fs.map((f) => fp.allowsFeature(f));
                }, FEATURES.map(([f]) => f));
                for (let i = 0; i < FEATURES.length; i++) {
                    const [f, def] = FEATURES[i]!;
                    const want = (await oracle.ask("allowframe", [a, f, def ? "1" : "0", parent, frameOrigin, frameOrigin])) === "yes";
                    if (got[i] !== want) bad.push(`${kind} ${JSON.stringify(a)} ${f}: Chromium ${got[i]}, spec ${want}`);
                }
            }
        }
        await page.close();
        expect(bad.slice(0, 12), `${bad.length} (seed ${seed})`).toEqual([]);
    }, 600_000);
});
