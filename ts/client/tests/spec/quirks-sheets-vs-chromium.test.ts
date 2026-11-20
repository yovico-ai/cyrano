// @vitest-environment node
//
// spec/Disposition.agda sheetApplies / addNosniff against Chromium: a
// <link rel=stylesheet> in a quirks or standards document, same- or
// cross-origin, of many Content-Types, with or without nosniff, applies as
// `sheetapplies` says; and the sheet as the proxy serves it — same-origin,
// nosniff added where `sheetnosniff` says — applies exactly where the
// original does.
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; waitForTimeout(ms: number): Promise<void>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

// null: no Content-Type header at all.
const TYPES: (string | null)[] = [null, "", "text/css", "TEXT/CSS", "text/css; charset=utf-8", " text/css", "text/plain", "application/octet-stream", "text/html",
    "foo", "text/css2", "*/*", ";"]; // (several types in one value: not covered)

describe.skipIf(!wanted || located.skip !== "")("Stylesheets by type, mode and origin: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/s.css") {
                const t = u.searchParams.get("t");
                if (t !== null) res.setHeader("Content-Type", t); else res.removeHeader("Content-Type");
                if (u.searchParams.get("ns") === "1") res.setHeader("X-Content-Type-Options", "nosniff");
                res.end("p{color:rgb(1,2,3)}");
                return;
            }
            res.setHeader("Content-Type", "text/html");
            res.end(`${u.searchParams.get("q") === "1" ? "" : "<!doctype html>"}<link rel=stylesheet href="${u.searchParams.get("h")}"><p>x</p>`);
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

    it("applies as the spec says; proxied as directly", async () => {
        const page = await browser.newPage();
        const applied = async (quirks: boolean, same: boolean, t: string | null, ns: boolean): Promise<boolean> => {
            const h = `http://${same ? "localhost" : "127.0.0.1"}:${port}/s.css?${t === null ? "" : `t=${encodeURIComponent(t)}&`}ns=${ns ? 1 : 0}`;
            await page.goto(`http://localhost:${port}/?q=${quirks ? 1 : 0}&h=${encodeURIComponent(h)}`);
            await page.waitForTimeout(30);
            return page.evaluate(() => getComputedStyle(document.querySelector("p")!).color === "rgb(1, 2, 3)");
        };
        const bad: string[] = [];
        for (const quirks of [true, false]) for (const same of [true, false]) for (const t of TYPES) for (const ns of [false, true]) {
            const ct = t === null ? "-" : t;
            const b = (x: boolean): string => (x ? "1" : "0");
            const direct = await applied(quirks, same, t, ns);
            const spec = (await oracle.ask("sheetapplies", [b(quirks), b(same), ct, b(ns)])) === "yes";
            const add = (await oracle.ask("sheetnosniff", [b(same), ct, b(ns)])) === "yes";
            const proxied = await applied(quirks, true, t, ns || add);
            const where = `${quirks ? "quirks" : "standards"} ${same ? "same" : "cross"}-origin ${JSON.stringify(t)}${ns ? " nosniff" : ""}`;
            if (direct !== spec) bad.push(`${where}: Chromium ${direct ? "applies" : "does not"}, spec ${spec ? "applies" : "does not"}`);
            if (proxied !== direct) bad.push(`${where}: proxied ${proxied ? "applies" : "does not"}, directly ${direct ? "applies" : "does not"}`);
        }
        await page.close();
        expect(bad.slice(0, 12), String(bad.length)).toEqual([]);
    }, 300_000);
});
