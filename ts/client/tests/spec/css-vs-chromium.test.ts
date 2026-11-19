// @vitest-environment node
//
// "The spec is the browser", for the URLs in CSS: the URLs spec/Css.agda
// finds in a stylesheet (`cssurls`) must be exactly the ones real Chromium
// requests. Each drawn rule names one URL form (or a decoy: a string, a
// comment, a bad url, a dimension) in a rendered element's
// background-image, or in an @import; the server records what is asked for.
// (image-set gets one candidate, so the browser's choice is that one.)
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { goto(u: string): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void>; version(): string };

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

// A URL form naming path n (a name the server can recognize).
const forms: ((n: string) => string)[] = [
    (n) => `url(${n}.png)`,
    (n) => `url( ${n}.png\t)`,
    (n) => `URL(${n}.png)`,
    (n) => `url("${n}.png")`,
    (n) => `url( '${n}.png' )`,
    (n) => `\\75rl(${n}.png)`,
    (n) => `url(${n}\\.png)`,
    (n) => `url(${n}\\2e png)`,
    (n) => `url(${n}\\(1\\).png)`,
    (n) => `url("${n}\\\n.png")`,
    (n) => `image-set("${n}.png" 1x)`,
    (n) => `-webkit-image-set(url(${n}.png) 1x)`,
    (n) => `image-set(url("${n}.png") 1x)`,
    (n) => `url(bad ${n}.png)`,
    (n) => `url(${n}".png)`,
    (n) => `url(${n}(.png)`,
];
// (An unterminated string or parenthesis would swallow the rules after it:
// their URL tokens are then in the text but never applied — rewriting
// them is harmless. Each draw here is otherwise well-formed, so the two
// sets must be equal; that the browser fetches nothing the spec misses is
// the containment property and holds whatever the text.)
// Decoys in other positions: never fetched.
const decoys: ((n: string) => string)[] = [
    (n) => `.d{content:"url(${n}.png)"}`,
    (n) => `/* url(${n}.png) */`,
    (n) => `.d{--x: 1url(${n}.png)}`,
    (n) => `.d{font-family:"${n}.png"}`,
];
const imports: ((n: string) => string)[] = [
    (n) => `@import"${n}.css";`,
    (n) => `@import url(${n}.css);`,
    (n) => `@IMPORT '${n}.css';`,
    (n) => `@import /* c */ "${n}.css";`,
    (n) => `@import url( "${n}.css" ) screen;`,
];

describe.skipIf(!wanted || located.skip !== "")("CSS URLs: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;
    let css = "";
    let rules = 0;
    const hits = new Set<string>();

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req, res) => {
            const u = decodeURIComponent((req.url ?? "/").split("?")[0]!);
            if (u === "/page") {
                res.writeHead(200, { "content-type": "text/html" });
                const divs = Array.from({ length: rules }, (_, i) => `<div class="c${i}" style="width:10px;height:10px"></div>`).join("");
                res.end(`<!doctype html><style>${css}</style>${divs}`);
                return;
            }
            hits.add(u);
            if (u.endsWith(".css")) { res.writeHead(200, { "content-type": "text/css" }); res.end(""); return; }
            res.writeHead(200, { "content-type": "image/png" });
            res.end(PNG);
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

    it("the URLs Chromium fetches are the ones the spec finds", async () => {
        const seed = Number(process.env.CYRANO_SEED ?? Date.now() % 1e9);
        const mismatches: string[] = [];
        for (let round = 0; round < 6; round++) {
            const draw = fc.sample(fc.record({
                imp: fc.array(fc.nat(imports.length - 1), { maxLength: 2 }),
                rules: fc.array(fc.nat(forms.length - 1), { minLength: 4, maxLength: 12 }),
                decoys: fc.array(fc.nat(decoys.length - 1), { maxLength: 3 }),
            }), { numRuns: 1, seed: seed + round })[0]!;
            const parts: string[] = [];
            draw.imp.forEach((k, i) => parts.push(imports[k]!(`r${round}i${i}`)));
            draw.decoys.forEach((k, i) => parts.push(decoys[k]!(`r${round}d${i}`)));
            draw.rules.forEach((k, i) => parts.push(`.c${i}{background-image:${forms[k]!(`r${round}u${i}`)}}`));
            css = parts.join("\n");
            rules = draw.rules.length;
            hits.clear();
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            await page.goto(`http://127.0.0.1:${port}/page`);
            await page.waitForTimeout(600);
            await ctx.close();
            const specUrls = ((await oracle.ask("cssurls", [css])) ?? "").split("\n").filter((s) => s !== "")
                .map((u) => new URL(u, `http://127.0.0.1:${port}/page`).pathname);
            const want = new Set(specUrls.map((p) => decodeURIComponent(p)));
            const got = new Set([...hits].filter((h) => h !== "/favicon.ico"));
            for (const w of want) if (!got.has(w)) mismatches.push(`spec finds ${w}, chromium does not fetch it — css: ${JSON.stringify(css)}`);
            for (const g of got) if (!want.has(g)) mismatches.push(`chromium fetches ${g}, spec does not find it — css: ${JSON.stringify(css)}`);
        }
        expect(mismatches.slice(0, 20), `${mismatches.length} differ (chromium ${browser.version()})`).toEqual([]);
    }, 300_000);
});
