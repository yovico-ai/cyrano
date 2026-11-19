// @vitest-environment node
//
// spec/Metadata.agda against Chromium: every request header Chromium sends
// — for navigations, frames, images, scripts, fetches — to a target that is
// not potentially trustworthy (http://u.test) or one that is (loopback) is
// one the spec lets reach it (`metadatasent`), and the fetch metadata does
// reach a trustworthy one.
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { goto(u: string): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

describe.skipIf(!wanted || located.skip !== "")("Fetch metadata: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;
    const seen: { host: string; names: string[] }[] = [];

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req, res) => {
            seen.push({ host: String(req.headers.host ?? "").replace(/:\d+$/, ""), names: Object.keys(req.headers) });
            res.setHeader("Access-Control-Allow-Origin", "*");
            if ((req.url ?? "").startsWith("/p")) {
                res.setHeader("Content-Type", "text/html");
                const o = (h: string): string => `http://${h}:${port}`;
                res.end(`<!doctype html><img src="${o("u.test")}/i"><img src="${o("localhost")}/i"><script src="${o("u.test")}/s.js"></script><script src="${o("localhost")}/s.js"></script>
                    <iframe src="${o("u.test")}/f"></iframe><iframe src="${o("localhost")}/f"></iframe>
                    <script>fetch("${o("u.test")}/x");fetch("${o("localhost")}/x");</script>`);
                return;
            }
            res.end("");
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o: object): Promise<Browser> } };
        browser = await chromium.launch({ args: ["--host-resolver-rules=MAP *.test 127.0.0.1"] });
    });
    afterAll(async () => {
        oracle?.close();
        await browser?.close();
        server?.close();
    });

    it("the headers that reach trustworthy and untrustworthy targets", async () => {
        for (const top of ["u.test", "localhost"]) {
            const page = await browser.newPage();
            await page.goto(`http://${top}:${port}/p`);
            await page.waitForTimeout(800);
            await page.close();
        }
        const bad: string[] = [];
        let trustedMeta = 0;
        for (const { host, names } of seen) {
            const tw = host === "localhost" ? "1" : "0";
            for (const n of names) {
                if ((await oracle.ask("metadatasent", [n, tw])) !== "yes") bad.push(`${n} reached ${host}`);
            }
            if (tw === "1" && names.includes("sec-fetch-mode")) trustedMeta++;
        }
        expect(bad, bad.join("\n")).toEqual([]);
        expect(trustedMeta, "no fetch metadata reached loopback").toBeGreaterThan(3);
        expect(seen.filter((s) => s.host === "u.test").length).toBeGreaterThan(3);
    }, 120_000);
});
