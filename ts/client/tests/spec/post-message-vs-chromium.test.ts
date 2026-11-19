// @vitest-environment node
//
// spec/Messaging.agda against Chromium: postMessage to a same-origin and
// a cross-origin frame with random targetOrigins is delivered, dropped or
// throws as the spec says (`postdelivery`).
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

type Page = { goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T | Promise<T>, a: A): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

describe.skipIf(!wanted || located.skip !== "")("postMessage targetOrigin: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req, res) => {
            res.setHeader("Content-Type", "text/html");
            if ((req.url ?? "").startsWith("/f")) {
                res.end(`<!doctype html><script>addEventListener("message", (e) => parent.postMessage({ got: e.data }, "*"));</script>`);
                return;
            }
            const cross = `http://127.0.0.1:${port}/f`;
            res.end(`<!doctype html><iframe id=same src="/f"></iframe><iframe id=cross src="${cross}"></iframe>`);
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

    it("delivered, dropped or thrown", async () => {
        const L = `localhost:${port}`;
        const I = `127.0.0.1:${port}`;
        const target = fc.constantFrom("*", "/", `http://${L}`, `http://${I}`, `http://${L}/p?q#f`, `http://u:p@${I}/x`, `HTTP://LOCALHOST:${port}`,
            `  http://${L}  `, `blob:http://${I}/uuid`, `BLOB:http://${L}/u`, "blob:nope", "data:x", "nope", "http://", L, "javascript:x",
            `http://${L}:1`, `https://${L}`, `ws://${I}`, `http://[::1]:${port}`, "", " ", "*/", "file:///x", "ftp://x", "FILE://h/p");
        const draws = fc.sample(target, { numRuns: 80, seed });
        const page = await browser.newPage();
        await page.goto(`http://${L}/`);
        const got = await page.evaluate(async (ts: string[]) => {
            await new Promise((r) => setTimeout(r, 300));
            const frames = { same: (document.getElementById("same") as HTMLIFrameElement).contentWindow!, cross: (document.getElementById("cross") as HTMLIFrameElement).contentWindow! };
            const out: Record<string, string> = {};
            addEventListener("message", (e) => { if (e.data && typeof e.data.got === "string") out[e.data.got] = "deliver"; });
            ts.forEach((t, k) => {
                for (const name of ["same", "cross"] as const) {
                    const id = `${name}${k}`;
                    try { frames[name].postMessage(id, t); out[id] = out[id] ?? "drop"; } catch (e) { out[id] = (e as Error).name === "SyntaxError" ? "throw" : `error ${(e as Error).name}`; }
                }
            });
            await new Promise((r) => setTimeout(r, 800));
            return out;
        }, draws);
        await page.close();
        const bad: string[] = [];
        for (let k = 0; k < draws.length; k++) {
            for (const [name, recipient] of [["same", `http://${L}`], ["cross", `http://${I}`]] as const) {
                const want = await oracle.ask("postdelivery", [`http://${L}`, recipient, draws[k]!]);
                if (got[`${name}${k}`] !== want) bad.push(`${JSON.stringify(draws[k])} to ${name}: Chromium ${got[`${name}${k}`]}, spec ${want}`);
            }
        }
        expect(bad.slice(0, 12), `${bad.length} (seed ${seed})`).toEqual([]);
    }, 120_000);
});
