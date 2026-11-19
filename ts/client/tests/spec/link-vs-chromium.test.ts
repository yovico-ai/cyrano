// @vitest-environment node
//
// "The spec is the browser", for spec/Link.agda: from a document's Link
// header Chromium fetches exactly what the spec reads (`linkpreloads`:
// the link-values that read, with rel prefetch, or preload of a known
// destination), and the
// header as the proxy rewrites it (`link`) makes it preload the same
// targets, proxified: the page cannot tell.
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

type Page = { goto(u: string): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };

const PARAMS = ["; rel=preload", ";rel=\"preload\"", "; REL=PRELOAD", "; rel=\"prefetch preload\"", "; rel=prefetch", "; rel=stylesheet",
    "; as=image", "; AS=\"IMAGE\"", "; as=\"im\\age\"", "; as=script", "; title=\"a, </i/x>; rel=preload; as=image\"", "; title=a b",
    "; title=\"x\\\"y,z\"", ";", ";;", "; =x", "; x=\"unterminated", "; integrity=sha384-AAAA", "; crossorigin=anonymous",
    "; crossorigin", "; imagesizes=50vw", " ; rel = preload ", "; title='a,b'", "; t=\"q\"junk"];
const LEADS = ["", " ", "x", "\t"];
const TRAILS = ["", " ", "x", ","];

/** A Link header and the image targets in it. */
const headerArb = fc.array(fc.tuple(fc.constantFrom(...LEADS), fc.constantFrom("", "  "), fc.array(fc.constantFrom(...PARAMS), { maxLength: 5 }), fc.constantFrom(...TRAILS)),
    { minLength: 1, maxLength: 5 }).map((vs) => vs.map(([lead, sp, ps, trail], k) => `${lead}<${sp}/i/${k}${sp}>${trail === "x" ? "x" : ""}${ps.join("")}${trail === "," ? "," : trail === " " ? " " : ""}`).join(", "));

let served: { link: string } = { link: "" };

describe.skipIf(!wanted || located.skip !== "")("Link header: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let ctx: Context;
    let server: Server;
    let port = 0;
    const hits: string[] = [];

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req, res) => {
            const path = decodeURIComponent(req.url ?? "/");
            if (/\/(i|s|x)\//.test(path) && !path.endsWith("/page")) {
                hits.push(path);
                res.writeHead(200, { "content-type": "image/png" });
                res.end();
                return;
            }
            res.writeHead(200, { "content-type": "text/html", link: served.link });
            res.end("<!doctype html><p>x");
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(): Promise<Browser> } };
        browser = await chromium.launch();
        ctx = await browser.newContext();
    });
    afterAll(async () => {
        oracle?.close();
        await browser?.close();
        server?.close();
    });

    const fetched = async (url: string, link: string): Promise<string[]> => {
        served = { link };
        hits.length = 0;
        const page = await ctx.newPage();
        await page.goto(url);
        await page.waitForTimeout(250);
        await page.close();
        return [...new Set(hits)].sort();
    };

    it("Chromium fetches what the spec reads; the rewritten header, the same proxified", async () => {
        const draws = fc.sample(headerArb, { numRuns: 150, seed });
        const base = `http://a.localhost:${port}/dir/page`;
        const proxy = `http://proxy.localhost:${port}`;
        const bad: string[] = [];
        let preloaded = 0;
        for (const h of draws) {
            // Chromium fetches a prefetch, and a preload of a destination it knows.
            const want = ((await oracle.ask("linkpreloads", [h])) ?? "").split("\n").filter((l) => l !== "")
                .map((l) => l.split("\t")).filter(([, as, rels]) => {
                    const r = (rels ?? "").split(" ");
                    return r.includes("prefetch") || (r.includes("preload") && ["image", "script", "style", "font", "fetch", "track"].includes(as!));
                }).map(([t]) => new URL(t!, base).pathname).sort();
            const direct = (await fetched(base, h)).filter((p) => p.startsWith("/i/") || p.startsWith("/x/"));
            preloaded += direct.length;
            if (JSON.stringify(direct) !== JSON.stringify([...new Set(want)])) bad.push(`direct ${JSON.stringify(h)}: Chromium ${JSON.stringify(direct)}, spec ${JSON.stringify(want)}`);
            const rewritten = (await oracle.ask("link", [proxy, base, h]))!;
            const viaProxy = (await fetched(`${proxy}/cyrano/http/a.localhost:${port}/dir/page`, rewritten))
                .filter((p) => p.includes("/i/") || p.includes("/x/"));
            const expected = direct.map((p) => `/cyrano/http/a.localhost:${port}${p}`);
            if (JSON.stringify(viaProxy) !== JSON.stringify(expected)) bad.push(`proxied ${JSON.stringify(h)} → ${JSON.stringify(rewritten)}: ${JSON.stringify(viaProxy)}, direct ${JSON.stringify(expected)}`);
        }
        expect(bad.slice(0, 10), `${bad.length} of ${draws.length} (seed ${seed})`).toEqual([]);
        expect(preloaded).toBeGreaterThan(draws.length / 6);
    }, 300_000);
});
