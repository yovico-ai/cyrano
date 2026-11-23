// @vitest-environment node
//
// spec/Disposition.agda against Chromium, for documents: a frame served
// with a random Content-Type (or none) and body is rendered as markup by
// Chromium exactly when the spec rewrites it as HTML (`disposition` for a
// document, sniffed by `sniffhtml`) — the MIME type as Chromium reads it,
// the types it does not take, its HTML sniff.
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server, type Socket } from "node:net";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";
const seed = Number(process.env.CYRANO_SEED ?? Date.now() % 1e9);

type Page = { goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T | Promise<T>, a: A): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const CT_PIECES = ["text/html", "TEXT/HTML", "text/plain", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/rss+xml", "text/foo+xml", "application/foo+xml", "unknown/unknown", "Application/Unknown", "*/*", "foo", "text", "/", "html",
    " ", ";", "charset=utf-8", ",", "x", "/x", "te xt"];
const BODY_PIECES = ["<p", "<P", "<b", "<bx", "<x", "<h1", "<h2", "<!--", "<!doctype html", "<!DOCTYPE HTM", "<script", "<scrip", "<?xml ?>", "<?XML ?>", "<rss>", "<feed>", "<!DOCTYPE x>", "hello", " ", "\f", "\r", "\v",
    " ".repeat(300), "<a", "<br", "<body", "<span", "﻿", ">"];

describe.skipIf(!wanted || located.skip !== "")("Documents' MIME types and sniffing: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;
    const cases: { ct: string | null; body: string }[] = [];

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        // A raw server: the Content-Type goes on the wire as written.
        server = createServer((sock: Socket) => {
            sock.on("data", (d) => {
                const m = /GET \/d\/(\d+)/.exec(d.toString("latin1"));
                const c = m ? cases[Number(m[1])] : undefined;
                const ct = c ? c.ct : "text/html";
                const body = Buffer.from(c ? c.body : "<!doctype html>top", "utf8");
                sock.end(Buffer.concat([Buffer.from("HTTP/1.1 200 OK\r\n" + (ct === null ? "" : `Content-Type: ${ct}\r\n`) +
                    `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`, "latin1"), body]));
            });
            sock.on("error", () => {});
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

    it("rendered as markup exactly when rewritten as HTML, or as XML", async () => {
        const ct = fc.option(fc.array(fc.constantFrom(...CT_PIECES), { maxLength: 4 }).map((a) => a.join("")), { nil: null });
        const body = fc.array(fc.constantFrom(...BODY_PIECES), { minLength: 1, maxLength: 4 }).map((a) => a.join("") + "<b id=t>x</b>");
        const draws = fc.sample(fc.tuple(ct, body), { numRuns: 150, seed });
        cases.length = 0;
        for (const [c, b] of draws) cases.push({ ct: c, body: b });
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${port}/`);
        const got = await page.evaluate(async (n: number) => {
            const out: string[] = [];
            for (let k = 0; k < n; k++) {
                const f = document.createElement("iframe");
                f.src = `/d/${k}`;
                const done = new Promise((r) => { f.onload = r; setTimeout(r, 1500); });
                document.body.append(f);
                await done;
                let r = "none";
                try {
                    const d = f.contentDocument;
                    // Rendered (not downloaded: the frame left about:blank) as markup.
                    const at = f.contentWindow?.location.pathname ?? "";
                    // An HTML document, or one the XML parser built (XHTML, SVG, XML: rewritten as XML).
                    // (A document Blink shows as text keeps its response type: judged by what Blink made.)
                    if (d && at === `/d/${k}`) {
                        const w = f.contentWindow as unknown as { XMLDocument: typeof XMLDocument; HTMLDocument: typeof HTMLDocument };
                        r = d instanceof w.XMLDocument ? "xml" : d.contentType === "text/html" && d instanceof w.HTMLDocument ? "html" : "none";
                    }
                } catch { r = "err"; }
                out.push(r);
                f.remove();
            }
            return out;
        }, draws.length);
        await page.close();
        const bad: string[] = [];
        let html = 0;
        for (let k = 0; k < draws.length; k++) {
            const [c, b] = draws[k]!;
            const sn = (await oracle.ask("sniff", [b]))!; // html, xml magic
            const want = await oracle.ask("disposition", ["-", "1", "document", c === null ? "0" : "1", c ?? "", sn[0]!, sn[1]!]);
            if (want === "html") html++;
            if (got[k] !== (want === "html" || want === "xml" ? want : "none")) bad.push(`${JSON.stringify(c)} ${JSON.stringify(b)}: Chromium ${got[k]}, spec ${want}`);
        }
        expect(bad.slice(0, 12), `${bad.length} (seed ${seed})`).toEqual([]);
        expect(html).toBeGreaterThan(10);
    }, 600_000);
});
