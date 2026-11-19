// @vitest-environment node
//
// spec/Dictionary.agda against Chromium: a response's Use-As-Dictionary
// as the origin wrote it makes Chromium offer the dictionary on the next
// matching request (Available-Dictionary, dcb / dcz in Accept-Encoding);
// as the proxy gives it to the browser (`dictreg`) it never does; and the
// Accept-Encoding Chromium sends holding a dictionary, filtered (`dictae`),
// is the one it sends holding none. Request headers the proxy removes are
// exactly those the offer added (`dictoffer`).
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T | Promise<T>): Promise<T>; waitForTimeout(ms: number): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };

// Values the origin may send: registering ones and not.
const VALUES = ['match="/d/*"', 'match="/d/*", type=raw', 'match="/d/*", id="x"', 'match="/d/*";a=1', 'match="/d/*", match-dest=("")', 'id="x", match="/d/*"',
    'match="/d/*", type=raw, id="y"', 'match="/d/*",', 'match=/d/', "type=raw", "", "(", 'match="/d/*" , type=raw'];

describe.skipIf(!wanted || located.skip !== "")("Compression dictionaries: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;
    let value = "";
    let seen: IncomingHttpHeaders[] = [];

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req, res) => {
            if ((req.url ?? "").startsWith("/d/")) seen.push(req.headers);
            if (req.url === "/dict") {
                res.setHeader("Use-As-Dictionary", value);
                res.setHeader("Cache-Control", "max-age=3600");
                res.end("dictionary text ".repeat(20));
                return;
            }
            res.setHeader("Content-Type", "text/html");
            res.setHeader("Cache-Control", "no-store");
            res.end("<!doctype html>x");
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

    // The headers of a matching request after a response carrying v.
    const after = async (v: string): Promise<IncomingHttpHeaders> => {
        value = v;
        seen = [];
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(`http://localhost:${port}/`);
        await page.evaluate(async () => { await (await fetch("/dict")).text(); });
        await page.waitForTimeout(300);
        await page.evaluate(async () => { await (await fetch("/d/x", { cache: "no-store" })).text(); });
        await ctx.close();
        return seen[0]!;
    };

    it("the changed header registers nothing; the filtered offer is a browser's without one", async () => {
        const bad: string[] = [];
        let registered = 0;
        const plain = await after("");
        const none = plain["accept-encoding"];
        for (const v of VALUES) {
            const direct = await after(v);
            const offered = direct["available-dictionary"] !== undefined;
            if (offered) {
                registered++;
                const filtered = await oracle.ask("dictae", [String(direct["accept-encoding"])]);
                if (filtered !== none) bad.push(`${v}: filtered ${direct["accept-encoding"]} is ${filtered}, without a dictionary ${none}`);
                for (const name of Object.keys(direct)) {
                    const added = !(name in plain);
                    const removed = (await oracle.ask("dictoffer", [name])) === "yes";
                    if (added !== removed && name !== "accept-encoding") bad.push(`${v}: header ${name} added by the offer ${added}, removed by the spec ${removed}`);
                }
            }
            const proxied = await after((await oracle.ask("dictreg", [v]))!);
            if (proxied["available-dictionary"] !== undefined || /dc[bz]/.test(String(proxied["accept-encoding"]))) bad.push(`${v}: registered as the proxy gives it`);
        }
        expect(bad, String(bad.length)).toEqual([]);
        expect(registered).toBeGreaterThan(4);
    }, 120_000);
});
