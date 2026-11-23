// @vitest-environment node
//
// spec/DataUrl.agda against Chromium: fetch() of a data: URL runs the
// browser's own data: URL processor. Where the spec reads a URL, Chromium
// gets exactly its bytes; where the spec says it does not read (no ",",
// bad base64), Chromium fails. (A MIME text holding "?" is outside the
// model, and so is a tab or newline inside the URL: Chromium keeps them
// in some, removes them in others. Not compared.)
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";
import { dataUrls } from "./data-url-conformance.test";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T | Promise<T>, a: A): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

describe.skipIf(!wanted || located.skip !== "")("data: URLs: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let page: Page;

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html>x"); });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(): Promise<Browser> } };
        browser = await chromium.launch();
        page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    });
    afterAll(async () => {
        oracle?.close();
        await browser?.close();
        server?.close();
    });

    it("reads every URL as Chromium does", async () => {
        const urls = fc.sample(dataUrls, 1500);
        const got = await page.evaluate(async (us: string[]) => {
            const out: string[] = [];
            for (const u of us) {
                try {
                    const b = new Uint8Array(await (await fetch(u)).arrayBuffer());
                    out.push(Array.from(b, (x) => (x < 16 ? "0" : "") + x.toString(16)).join(""));
                } catch { out.push("fail"); }
            }
            return out;
        }, urls);
        for (let i = 0; i < urls.length; i++) {
            const u = urls[i]!;
            const want = await oracle.ask("dataurl", [u]);
            if (!/^\s*data:/i.test(u.replace(/^[\x00-\x20]+/, ""))) continue; // not a data: URL: fetch fails another way
            const head = u.slice(0, u.indexOf(",") >= 0 ? u.indexOf(",") : u.length);
            if (head.includes("?") || head.includes("#")) continue; // outside the model
            if (/[\t\n\r]/.test(u.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, ""))) continue; // a tab or newline inside: outside the model
            expect({ u, bytes: got[i] }).toEqual({ u, bytes: want === "none" ? "fail" : want!.split("\t")[2] });
        }
    });
});
