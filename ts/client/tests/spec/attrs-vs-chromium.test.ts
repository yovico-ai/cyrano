// @vitest-environment node
//
// "The spec is the browser", for spec/Attrs.agda: every (element,
// attribute) Chromium fetches from is url, urllist or srcset to the spec;
// every one it does not fetch from is none or reflected (navigations are
// outside this probe); every IDL property that resolves a URL is on an
// attribute the spec does not call none.
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { goto(u: string): Promise<unknown>; evaluate<T>(f: () => T): Promise<T>; waitForTimeout(ms: number): Promise<void>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void>; version(): string };

// [namespace, element, attribute]: each placed where it would load.
const cases: [string, string, string][] = [
    ["html", "img", "src"], ["html", "img", "lowsrc"], ["html", "img", "longdesc"], ["html", "img", "srcset"], ["html", "img", "attributionsrc"],
    ["html", "iframe", "src"], ["html", "iframe", "longdesc"], ["html", "embed", "src"], ["html", "object", "data"], ["html", "object", "codebase"],
    ["html", "object", "archive"], ["html", "object", "classid"], ["html", "script", "src"], ["html", "script", "attributionsrc"], ["html", "link", "href"],
    ["html", "link", "imagesrcset"], ["html", "video", "src"], ["html", "video", "poster"], ["html", "audio", "src"], ["html", "source", "src"],
    ["html", "track", "src"], ["html", "input", "src"], ["html", "table", "background"], ["html", "td", "background"], ["html", "th", "background"],
    ["html", "tr", "background"], ["html", "thead", "background"], ["html", "tbody", "background"], ["html", "tfoot", "background"],
    ["html", "blockquote", "cite"], ["html", "q", "cite"], ["html", "del", "cite"], ["html", "ins", "cite"], ["html", "image", "src"],
    ["svg", "image", "href"], ["svg", "image", "xlink:href"], ["svg", "use", "href"], ["svg", "use", "xlink:href"], ["svg", "feimage", "href"],
    ["svg", "feimage", "xlink:href"], ["svg", "script", "href"], ["svg", "pattern", "href"], ["svg", "lineargradient", "href"], ["svg", "filter", "href"],
];

function fragment(ns: string, t: string, a: string, i: number): string {
    const u = `/hit/${i}`;
    if (ns === "svg") {
        const n = { feimage: "feImage", lineargradient: "linearGradient" }[t] ?? t;
        const at = `${a}="${u}#x"`;
        if (n === "feImage") return `<svg xmlns:xlink="http://www.w3.org/1999/xlink"><filter id="f${i}"><feImage ${at}/></filter><rect width="9" height="9" filter="url(#f${i})"/></svg>`;
        if (n === "pattern" || n === "linearGradient" || n === "filter")
            return `<svg><defs><${n} id="g${i}" ${at}></${n}></defs><rect width="9" height="9" fill="url(#g${i})"/></svg>`;
        return `<svg xmlns:xlink="http://www.w3.org/1999/xlink" width="20" height="20"><${n} ${at} width="9" height="9"></${n}></svg>`;
    }
    if (t === "td" || t === "th") return `<table><tr><${t} ${a}="${u}">x</${t}></tr></table>`;
    if (t === "tr") return `<table><tr ${a}="${u}"><td>x</td></tr></table>`;
    if (t === "thead" || t === "tbody" || t === "tfoot") return `<table><${t} ${a}="${u}"><tr><td>x</td></tr></${t}></table>`;
    if (t === "input") return `<input type="image" ${a}="${u}">`;
    if (t === "link") return a === "href" ? `<link rel="stylesheet" href="${u}">` : `<link rel="preload" as="image" href="/x.png" imagesrcset="${u} 1x">`;
    if (t === "source") return `<video><source ${a}="${u}"></video>`;
    if (t === "track") return `<video src="/v.mp4"><track default ${a}="${u}"></video>`;
    if (t === "object") return `<object ${a}="${u}" ${a !== "data" ? 'data="/o.png" type="image/png"' : ""}></object>`;
    if (a === "srcset") return `<img srcset="${u} 1x">`;
    if (a === "attributionsrc") return `<${t} ${t === "img" ? 'src="/i.png"' : 'src="/s.js"'} attributionsrc="${u}"></${t}>`;
    if (["blockquote", "q", "del", "ins"].includes(t)) return `<${t} ${a}="${u}">x</${t}>`;
    return `<${t} ${a}="${u}"></${t}>`;
}

describe.skipIf(!wanted || located.skip !== "")("URL attributes: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;
    let html = "";
    const hits = new Set<string>();

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req, res) => {
            const m = /^\/hit\/([^/?#]+)/.exec(req.url ?? "");
            if (m) hits.add(m[1]!);
            if (req.url === "/p") { res.writeHead(200, { "content-type": "text/html" }); res.end(html); return; }
            if (req.url === "/fs") { res.writeHead(200, { "content-type": "text/html" }); res.end(`<frameset><frame src="/hit/frame"></frameset>`); return; }
            if (req.url === "/bg") { res.writeHead(200, { "content-type": "text/html" }); res.end(`<body background="/hit/body">`); return; }
            res.writeHead(404); res.end();
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

    it("what Chromium fetches from is a URL to the spec, and only that", async () => {
        html = "<!doctype html><body>" + cases.map(([n, t, a], i) => fragment(n, t, a, i)).join("\n") + "</body>";
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${port}/p`);
        await page.goto(`http://127.0.0.1:${port}/fs`);
        await page.goto(`http://127.0.0.1:${port}/bg`);
        await page.goto(`http://127.0.0.1:${port}/p`);
        await page.waitForTimeout(2500);
        await page.close();
        const fetching = new Set(["url", "urllist", "srcset"]);
        const checks: [string, string, string, boolean][] = cases.map(([n, t, a], i) => [n, t, a, hits.has(String(i))]);
        checks.push(["html", "frame", "src", hits.has("frame")], ["html", "body", "background", hits.has("body")]);
        const bad: string[] = [];
        for (const [n, t, a, fetched] of checks) {
            const kind = await oracle.ask("attrkind", [n, t, a]);
            if (fetched !== fetching.has(kind ?? "")) bad.push(`${n} ${t} ${a}: spec ${kind}, chromium ${fetched ? "fetches" : "does not fetch"}`);
        }
        expect(bad, `chromium ${browser.version()}`).toEqual([]);
    }, 120_000);

    it("every IDL property resolving a URL is on an attribute the spec names", async () => {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${port}/p`);
        const found = await page.evaluate(() => {
            const tags = "a area audio base blockquote body button del embed form frame iframe img input ins link object q script source track video table td th tr".split(" ");
            const out: string[] = [];
            const want = new URL("rel/x", document.baseURI).href;
            for (const t of tags) {
                const el = document.createElement(t);
                const props = new Set<string>();
                for (let o: object | null = el; o; o = Object.getPrototypeOf(o)) for (const k of Object.getOwnPropertyNames(o)) props.add(k);
                for (const n of [...props].map((k) => k.toLowerCase()).filter((k) => /^[a-z]+$/.test(k))) {
                    try { el.setAttribute(n, "rel/x"); } catch { continue; }
                    for (const k of props) {
                        let v: unknown;
                        try { v = (el as unknown as Record<string, unknown>)[k]; } catch { continue; }
                        if (v === want) out.push(`${t} ${n}`);
                    }
                    el.removeAttribute(n);
                }
            }
            return [...new Set(out)];
        });
        await page.close();
        const bad: string[] = [];
        for (const pair of found) {
            const [t, a] = pair.split(" ");
            if ((await oracle.ask("attrkind", ["html", t!, a!])) === "none") bad.push(`${pair}: a URL to Chromium, none to the spec`);
        }
        expect(found.length).toBeGreaterThan(20);
        expect(bad, `chromium ${browser.version()}`).toEqual([]);
    }, 120_000);
});
