// @vitest-environment node
//
// spec/Upgrades.agda against Chrome: which http navigations Chrome tries
// over https first (`upgradable`; whether the last label is an ICANN TLD,
// from tldts), and that a host which fell back is not tried again
// (`upgradesteps`: "n0 f0 n1" → U B P).
//
// Names resolve to local servers (--host-resolver-rules): port 443 to one
// that drops the connection (the upgrade fails), the rest to an http
// server. Playwright's Chromium switches HTTPS-Upgrades off, and even
// switched on it does not upgrade: this needs real Chrome, headed, on a
// display (CYRANO_CHROME=1, DISPLAY=:98).

import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { createServer as netServer, type Server as NetServer } from "node:net";
import { parse } from "tldts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_CHROME === "1";

type Request = { url(): string };
type Page = { goto(u: string, o?: object): Promise<unknown>; on(e: "request", f: (r: Request) => void): void };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };

const HOSTS = ["upgrade-probe.com", "a.b.co.uk", "upgrade-probe.com.", "bucher.xn--p1ai", "x.github.io", "github.io", "Mixed.Case.Org",
    "a.example", "upgrade-probe.test", "intranet", "foo.localhost", "co.uk", "x.invalid", "a.local",
    "com", "uk", "a.ck", "b.a.ck", "www.ck", "kawasaki.jp", "a.kawasaki.jp", "b.a.kawasaki.jp", "city.kawasaki.jp", "blogspot.com", "a.blogspot.com"];
const PORTS = process.env.PORTS === "1" ? [""] : ["", ":80", ":8080"];

const registry = (host: string): boolean => {
    const tld = host.replace(/\.$/, "").split(".").pop()!;
    return parse(`x.${tld}`, { allowPrivateDomains: false }).isIcann === true;
};

describe.skipIf(!wanted || located.skip !== "")("HTTPS-Upgrades: the spec is Chrome", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let http: Server;
    let tls: NetServer;

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        http = createServer((_q, res) => res.end("<!doctype html>http"));
        tls = netServer((s) => s.destroy());
        await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
        await new Promise<void>((r) => tls.listen(0, "127.0.0.1", () => r()));
        const hp = (http.address() as { port: number }).port;
        const tp = (tls.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o: object): Promise<Browser> } };
        const sw = require(new URL("../../../e2e/node_modules/playwright-core/lib/server/chromium/chromiumSwitches.js", import.meta.url).pathname) as Record<string, (a: boolean, c?: string, d?: boolean) => string[]>;
        const dis = (sw["chromiumSwitches"] ?? sw["default"])!(false, undefined, false).find((a) => a.startsWith("--disable-features="))!;
        browser = await chromium.launch({
            channel: "chrome", headless: false, ignoreDefaultArgs: [dis],
            args: [`--host-resolver-rules=MAP *:443 127.0.0.1:${tp}, MAP *:80 127.0.0.1:${hp}, MAP *:8080 127.0.0.1:${hp}`, dis.replace("HttpsUpgrades,", "")],
        });
    });
    afterAll(async () => {
        oracle?.close();
        await browser?.close();
        http?.close();
        tls?.close();
    });

    it("which navigations are tried over https, and a fallback is kept", async () => {
        const bad: string[] = [];
        for (const host of HOSTS) {
            for (const port of PORTS) {
                const ctx = await browser.newContext();
                const page = await ctx.newPage();
                const urls: string[] = [];
                page.on("request", (r) => urls.push(r.url()));
                await page.goto(`http://${host}${port}/`, { timeout: 15_000 });
                const tried = urls.some((u) => u.startsWith("https:"));
                urls.length = 0;
                await page.goto(`http://${host}${port}/again`, { timeout: 15_000 });
                const triedAgain = urls.some((u) => u.startsWith("https:"));
                await ctx.close();
                const want = (await oracle.ask("upgradable", [`${host.toLowerCase()}${port}`, registry(host) ? "1" : "0"])) === "yes";
                if (tried !== want) bad.push(`${host}${port}: Chrome ${tried ? "upgraded" : "did not upgrade"}, spec ${want ? "upgrades" : "does not"}`);
                if (want) {
                    const steps = await oracle.ask("upgradesteps", ["n0 f0 n1"]);
                    if (steps !== "UBP" || triedAgain) bad.push(`${host}${port}: after the fallback Chrome ${triedAgain ? "tried https again" : "kept http"}, spec ${steps}`);
                }
            }
        }
        expect(bad, bad.join("\n")).toEqual([]);
    }, 600_000);
});
