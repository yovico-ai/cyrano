// @vitest-environment node
//
// spec/Storage.agda against Chromium: in random frame trees over three
// sites, every request a document makes — fetch with each credentials
// mode, an image, a frame's navigation — carries Sec-Fetch-Storage-Access
// as the spec says (`storageaccess`, from the chain of sites).
//
// The sites are a.localhost, b.localhost, c.localhost (loopback, so
// potentially trustworthy: Chromium sends no Sec-Fetch- header to an http
// name that is not; such targets are checked through http://*.test). Needs the oracle and Playwright's Chromium;
// `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type IncomingMessage, type Server } from "node:http";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";
const seed = Number(process.env.CYRANO_SEED ?? Date.now() % 1e9);

type Page = { goto(u: string): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };

const SITES = ["a.localhost", "b.localhost", "c.localhost", "u.test"];
const trustworthy = (site: string): boolean => site.endsWith(".localhost");
type Req = { kind: "default" | "include" | "omit" | "same-origin" | "img"; site: string };
type Doc = { site: string; reqs: Req[]; frames: Doc[] };

const doc: fc.Memo<Doc> = fc.memo((depth) => fc.record({
    site: fc.constantFrom(...SITES.filter(trustworthy)),
    reqs: fc.array(fc.record({ kind: fc.constantFrom("default", "include", "omit", "same-origin", "img") as fc.Arbitrary<Req["kind"]>, site: fc.constantFrom(...SITES) }), { maxLength: 3 }),
    frames: depth > 1 ? fc.array(doc(depth - 1), { maxLength: 2 }) : fc.constant([]),
}));

describe.skipIf(!wanted || located.skip !== "")("Sec-Fetch-Storage-Access: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;
    const docs = new Map<string, { d: Doc; ids: string[] }>();
    const seen = new Map<string, string>();

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req: IncomingMessage, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            const id = u.searchParams.get("id") ?? "";
            if (id !== "") seen.set(id, String(req.headers["sec-fetch-storage-access"] ?? "-"));
            const entry = u.pathname === "/doc" ? docs.get(id) : undefined;
            if (entry) {
                res.setHeader("Content-Type", "text/html");
                const { d, ids } = entry;
                const js = d.reqs.map((r, i) => r.kind === "img"
                    ? `new Image().src="http://${r.site}:${port}/r?id=${ids[i]}";`
                    : `fetch("http://${r.site}:${port}/r?id=${ids[i]}"${r.kind === "default" ? "" : `,{credentials:"${r.kind}"}`}).catch(()=>{});`).join("");
                const frames = d.frames.map((_f, j) => `<iframe src="http://${d.frames[j]!.site}:${port}/doc?id=${ids[d.reqs.length + j]}"></iframe>`).join("");
                res.end(`<!doctype html><script>${js}</script>${frames}`);
                return;
            }
            res.setHeader("Access-Control-Allow-Origin", String(req.headers.origin ?? "*"));
            res.setHeader("Access-Control-Allow-Credentials", "true");
            res.end("x");
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o: object): Promise<Browser> } };
        browser = await chromium.launch({ args: [`--host-resolver-rules=MAP *.test 127.0.0.1`] });
    });
    afterAll(async () => {
        oracle?.close();
        await browser?.close();
        server?.close();
    });

    it("the header on each request of a frame tree", async () => {
        const draws = fc.sample(doc(3), { numRuns: 25, seed });
        const bad: string[] = [];
        let actives = 0;
        let n = 0;
        for (const top of draws) {
            // Each request: [id, mode, dest, credentials, chain, from, to].
            const expect_: [string, string, string, string, string[], string, string][] = [];
            const plan = (d: Doc, chain: string[]): string => {
                const id = `d${n++}`;
                const ids: string[] = [];
                const mine = [...chain, d.site];
                for (const r of d.reqs) {
                    const rid = `r${n++}`;
                    ids.push(rid);
                    const mode = r.kind === "img" ? "no-cors" : "cors";
                    const cred = r.kind === "img" || r.kind === "include" ? "include" : r.kind === "omit" ? "omit" : "same-origin";
                    expect_.push([rid, mode, r.kind === "img" ? "image" : "empty", cred, mine, `http://${d.site}:${port}`, r.site]);
                }
                for (const f of d.frames) {
                    const fid = plan(f, mine);
                    ids.push(fid);
                    expect_.push([fid, "navigate", "iframe", "include", mine, `http://${d.site}:${port}`, f.site]);
                }
                docs.set(id, { d, ids });
                return id;
            };
            const topId = plan(top, []);
            seen.clear();
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            await page.goto(`http://${top.site}:${port}/doc?id=${topId}`);
            await page.waitForTimeout(400);
            await ctx.close();
            for (const [id, mode, dest, cred, chain, from, site] of expect_) {
                const want = await oracle.ask("storageaccess", [mode, dest, cred, chain.join(" "), from, `http://${site}:${port}`, site, trustworthy(site) ? "1" : "0"]);
                const got = seen.get(id) ?? "(no request)";
                const norm = got === "-" ? "none" : got;
                if (want === "active") actives++;
                if (norm !== want) bad.push(`${mode} ${dest} ${cred} chain ${chain.join(">")} → ${site}: Chromium ${got}, spec ${want}`);
            }
        }
        expect(bad.slice(0, 12), `${bad.length} (seed ${seed})`).toEqual([]);
        expect(actives, "no request the header goes on").toBeGreaterThan(0);
    }, 600_000);
});
