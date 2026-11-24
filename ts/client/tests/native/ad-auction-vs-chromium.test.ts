// @vitest-environment node
//
// Protected Audience, in real Chromium, direct and through the real proxy
// (round I: a join for another owner had the browser fetch the owner's
// /.well-known/interest-group/permissions/ itself, outside the proxy). The
// runtime answers as Chrome answers a caller it does not allow
// (spec/AdAuction.agda): nothing reaches the owner, and the page reads
// what it reads directly — a join for its own origin resolves, one for
// another owner rejects NotAllowedError, an auction resolves null, an
// incomplete group gets the native's TypeError.
//
// The page is https on cyrano.test (in /etc/hosts; the dev CA). Needs the
// built server and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { connect } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const binary = process.env.CYRANO_BINARY ?? resolve(root, "go/assets/cyrano");
const ca = "/home/igor/work/cyrano-dev-ca";
const host = "cyrano.test";
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(binary) && existsSync(`${ca}/cert.pem`) &&
    readFileSync("/etc/hosts", "utf8").split("\n").some((l) => !l.trim().startsWith("#") && l.split(/\s+/).includes(host));

type Page = { goto(u: string, o?: object): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };


const free = (): Promise<number> => new Promise((r) => { const s = createHttp().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

describe.skipIf(!wanted)("Protected Audience, in Chromium, through the proxy", () => {
    let browser: Browser;
    let page: ReturnType<typeof createHttps>;
    let owner: ReturnType<typeof createHttps>;
    let proxy: ChildProcess;
    let proxyOrigin = "";
    let pageOrigin = "";
    let ownerOrigin = "";
    let reached: string[] = [];

    beforeAll(async () => {
        const tls = { cert: readFileSync(`${ca}/cert.pem`), key: readFileSync(`${ca}/key.pem`) };
        owner = createHttps(tls, (req: IncomingMessage, res: ServerResponse) => {
            reached.push(req.url ?? "");
            res.writeHead(404);
            res.end();
        });
        await new Promise<void>((r) => owner.listen(0, "127.0.0.1", () => r()));
        ownerOrigin = `https://${host}:${(owner.address() as { port: number }).port}`;
        page = createHttps(tls, (_req, res) => {
            res.writeHead(200, { "content-type": "text/html" });
            res.end(`<!doctype html><body><script>
window.out = null;
(async () => {
    const o = {};
    const t = async (k, f) => { try { const v = await f(); o[k] = "ok " + (v === undefined ? "undefined" : JSON.stringify(v)); } catch (e) { o[k] = "throw " + e.name + ": " + e.message; } };
    if (!("joinAdInterestGroup" in navigator)) { window.out = "absent"; return; }
    await t("joinSame", () => navigator.joinAdInterestGroup({ owner: location.origin, name: "x", biddingLogicURL: location.origin + "/b.js", lifetimeMs: 100000 }));
    await t("joinCross", () => navigator.joinAdInterestGroup({ owner: "${ownerOrigin}", name: "x", biddingLogicURL: "${ownerOrigin}/b.js", lifetimeMs: 100000 }));
    await t("joinMissing", () => navigator.joinAdInterestGroup({ owner: "${ownerOrigin}", name: "x" }));
    await t("auction", () => navigator.runAdAuction({ seller: "${ownerOrigin}", decisionLogicURL: "${ownerOrigin}/d.js", interestGroupBuyers: ["${ownerOrigin}"] }));
    await t("auctionMissing", () => navigator.runAdAuction({}));
    window.out = o;
})();
</script></body>`);
        });
        await new Promise<void>((r) => page.listen(0, "127.0.0.1", () => r()));
        pageOrigin = `https://${host}:${(page.address() as { port: number }).port}`;
        const port = await free();
        // Over TLS, as deployed: from an http proxy origin the native refuses
        // every join (SecurityError) before it fetches anything.
        proxyOrigin = `https://localhost:${port}`;
        proxy = spawn(binary, ["--assets", process.env.CYRANO_ASSETS ?? resolve(root, "go/assets"), "--log-level", "warn"], {
            env: { ...process.env, SSL_CERT_FILE: `${ca}/ca.pem`, CYRANO_PUBLIC_URL: proxyOrigin, CYRANO_PORT: String(port), CYRANO_HOSTNAME: "localhost",
                CYRANO_HTTPS_ENABLED: "true", CYRANO_SSL_CERT: `${ca}/cert.pem`, CYRANO_SSL_KEY: `${ca}/key.pem` },
            stdio: "ignore",
        });
        for (let i = 0; i < 100; i++) {
            const up = await new Promise<boolean>((r) => { const c = connect(port, "127.0.0.1", () => { c.destroy(); r(true); }); c.on("error", () => r(false)); });
            if (up) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch({ args: ["--ignore-certificate-errors"] });
    });
    afterAll(async () => {
        await browser?.close();
        proxy?.kill();
        page?.close();
        owner?.close();
    });

    const run = async (url: string): Promise<{ out: unknown; reached: string[] }> => {
        reached = [];
        const p = await browser.newPage();
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => undefined);
        let out: unknown = null;
        for (let i = 0; i < 50 && out === null; i++) {
            await new Promise((res) => setTimeout(res, 200));
            out = await p.evaluate(() => (window as unknown as { out: unknown }).out);
        }
        await new Promise((res) => setTimeout(res, 1000));
        await p.close();
        return { out, reached: [...reached] };
    };

    it("answers as directly, and nothing reaches the owner", async () => {
        const direct = await run(`${pageOrigin}/p`);
        const proxied = await run(`${proxyOrigin}/cyrano/https/${pageOrigin.slice(8)}/p`);
        expect(proxied.out).toEqual(direct.out);
        expect(proxied.reached).toEqual([]);
    }, 60_000);
});
