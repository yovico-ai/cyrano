// @vitest-environment node
//
// spec/Frames.agda against Chromium: iframes and objects of many sources
// (same- and cross-origin, relative, about:blank, javascript:, data:,
// blob:, srcdoc) — once loaded, the frame's document is reachable from
// the page exactly when `frameorigin` says same-origin, given the URL as
// the element's src / data property reads it.
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T | Promise<T>, a: A): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

describe.skipIf(!wanted || located.skip !== "")("Frame origins: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><p>x"); });
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

    it("a loaded frame is reachable as the spec says", async () => {
        const P = port;
        const srcs = ["/f", "f", "", "about:blank", "javascript:'<p>x'", "data:text/html,x", "BLOB", `http://127.0.0.1:${P}/f`, `//127.0.0.1:${P}/f`,
            `HTTP://LOCALHOST:${P}/f`, `http://localhost:${P}/f?q#h`, `http://localhost:${P + 1 === 65536 ? 1 : P + 1}/x`, `http://u:p@localhost:${P}/f`, `http://[::1]:${P}/f`, "?q", "#h"];
        const page = await browser.newPage();
        await page.goto(`http://localhost:${P}/dir/page`);
        const rows = await page.evaluate(async (ss: string[]) => {
            const out: { tag: string; srcdoc: boolean; given: string; read: string; reachable: boolean }[] = [];
            const blob = URL.createObjectURL(new Blob(["<p>b"], { type: "text/html" }));
            for (const given0 of ss) {
                const given = given0 === "BLOB" ? blob : given0;
                for (const [tag, srcdoc] of [["iframe", false], ["iframe", true], ["object", false]] as const) {
                    const el = document.createElement(tag) as HTMLIFrameElement & HTMLObjectElement;
                    if (tag === "object") { el.type = "text/html"; el.data = given; } else { el.src = given; }
                    if (srcdoc) el.srcdoc = "<p>s";
                    document.body.appendChild(el);
                    await new Promise((r) => { el.onload = r; el.onerror = r; setTimeout(r, 1500); });
                    await new Promise((r) => setTimeout(r, 50));
                    let reachable = false;
                    try { reachable = el.contentDocument !== null && el.contentDocument.body !== undefined; } catch { reachable = false; }
                    out.push({ tag, srcdoc, given, read: tag === "object" ? el.data : el.src, reachable });
                    el.remove();
                }
            }
            return out;
        }, srcs);
        await page.close();
        const bad: string[] = [];
        let cross = 0;
        for (const r of rows) {
            const want = await oracle.ask("frameorigin", [r.tag === "object" ? "1" : "0", r.srcdoc ? "1" : "0", r.read, `http://localhost:${P}`]);
            if (!r.reachable) cross++;
            if (r.reachable !== (want === "same")) bad.push(`${r.tag}${r.srcdoc ? "+srcdoc" : ""} ${JSON.stringify(r.given)} (reads ${JSON.stringify(r.read)}): Chromium ${r.reachable ? "reachable" : "cross-origin"}, spec ${want}`);
        }
        expect(bad, String(bad.length)).toEqual([]);
        expect(cross).toBeGreaterThan(5);
    }, 180_000);
});
