// @vitest-environment node
//
// spec/Storage.agda partitionKey against Chromium with third-party storage
// partitioning on (as in Chrome; Playwright switches it off): a value one
// context writes to localStorage is read by another exactly when the
// spec's keys for the two are equal — over frame chains of same-site and
// cross-site origins.
//
// Names under .com resolve to a local server (--host-resolver-rules), so
// www.one.com and sub.one.com are one site. Needs the oracle and
// Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { goto(u: string): Promise<unknown>; on(e: "console", f: (m: { text(): string }) => void): void; waitForTimeout(ms: number): Promise<void>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };

// Each context: the chain of hosts from the top-level document down to it.
const CHAINS = [["www.one.com"], ["sub.one.com"], ["two.com"], ["www.one.com", "two.com"], ["sub.one.com", "two.com"], ["two.com", "www.one.com"],
    ["www.one.com", "sub.one.com"], ["www.one.com", "two.com", "www.one.com"], ["two.com", "two.com"]];
const site = (host: string): string => `http://${host.split(".").slice(-2).join(".")}`;

describe.skipIf(!wanted || located.skip !== "")("Storage partitions: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            const rest = (u.searchParams.get("chain") ?? "").split(",").filter((h) => h !== "");
            const act = u.searchParams.get("act") ?? "";
            res.setHeader("Content-Type", "text/html");
            if (rest.length > 0) {
                const next = `http://${rest[0]}:${port}/?chain=${rest.slice(1).join(",")}&act=${encodeURIComponent(act)}`;
                res.end(`<!doctype html><iframe src="${next}"></iframe>`);
                return;
            }
            res.end(`<!doctype html><script>
                const a = ${JSON.stringify(act)};
                if (a.startsWith("w:")) { localStorage.setItem("k", a.slice(2)); console.log("DONE"); }
                else console.log("READ " + localStorage.getItem("k"));
            </script>`);
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o: object): Promise<Browser> } };
        const sw = require(new URL("../../../e2e/node_modules/playwright-core/lib/server/chromium/chromiumSwitches.js", import.meta.url).pathname) as Record<string, (a: boolean, c?: string, d?: boolean) => string[]>;
        const dis = (sw["chromiumSwitches"] ?? sw["default"])!(false, undefined, false).find((a) => a.startsWith("--disable-features="))!;
        browser = await chromium.launch({ ignoreDefaultArgs: [dis], args: [`--host-resolver-rules=MAP *.com 127.0.0.1:${port}`, dis.replace("ThirdPartyStoragePartitioning,", "")] });
    });
    afterAll(async () => {
        oracle?.close();
        await browser?.close();
        server?.close();
    });

    const run = async (page: Page, chain: string[], act: string): Promise<string> => {
        let out = "";
        page.on("console", (m) => { if (m.text().startsWith("READ ") || m.text() === "DONE") out = m.text(); });
        await page.goto(`http://${chain[0]}:${port}/?chain=${chain.slice(1).join(",")}&act=${encodeURIComponent(act)}`);
        for (let i = 0; i < 30 && out === ""; i++) await page.waitForTimeout(100);
        return out;
    };
    const key = async (chain: string[]): Promise<string> => {
        const own = chain[chain.length - 1]!;
        return (await oracle.ask("storagekey", [chain.slice(0, -1).map(site).join(" "), site(own), `http://${own}:${port}`]))!;
    };

    it("a value is read where the keys are equal", async () => {
        const bad: string[] = [];
        let shared = 0;
        for (let i = 0; i < CHAINS.length; i++) {
            const ctx = await browser.newContext();
            const w = await ctx.newPage();
            if ((await run(w, CHAINS[i]!, `w:v${i}`)) !== "DONE") bad.push(`${CHAINS[i]!.join(">")}: write did not run`);
            for (let j = 0; j < CHAINS.length; j++) {
                const r = await ctx.newPage();
                const got = await run(r, CHAINS[j]!, "r");
                await r.close();
                const seen = got === `READ v${i}`;
                const same = (await key(CHAINS[i]!)) === (await key(CHAINS[j]!));
                if (seen && i !== j) shared++;
                if (seen !== same) bad.push(`written in ${CHAINS[i]!.join(">")}, read in ${CHAINS[j]!.join(">")}: Chromium ${seen ? "shared" : "apart"}, spec ${same ? "shared" : "apart"} (${got})`);
            }
            await ctx.close();
        }
        expect(bad.slice(0, 12), String(bad.length)).toEqual([]);
        expect(shared).toBeGreaterThan(0);
    }, 300_000);
});
