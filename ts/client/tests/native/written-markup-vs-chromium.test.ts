// @vitest-environment node
//
// Markup a page writes, through the runtime, in real Chromium: written into
// an empty frame (document.write), as an iframe's srcdoc, and as innerHTML,
// it must make the same tree as it does directly — the same elements in the
// same namespaces, the same attributes, text and comments (the runtime's
// rewriting aside: attribute values and script text are not compared, the
// bootstrap's own scripts are left out). The markup is the tokenizer's
// hard cases (tests/spec/html-gen.ts): what the runtime takes for a tag
// before handing it to a <template> is spec/HtmlTok.agda's.
//
// Needs the built bundle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { documentArb, markupArb } from "../spec/html-gen";

const bundlePath = resolve(__dirname, "../../../../go/assets/client/rewriter.js");
const wanted = process.env.CYRANO_BROWSER === "1" && existsSync(bundlePath);
const seed = Number(process.env.CYRANO_SEED ?? Date.now() % 1e9);

type Page = {
    goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T, a: A): Promise<T>; close(): Promise<void>;
    waitForTimeout(ms: number): Promise<void>; on(e: "request", f: (r: { url(): string }) => void): void;
};
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

type Shape = { write: string; srcdoc: string; inner: string };

describe.skipIf(!wanted)("written markup makes the direct tree, in Chromium", () => {
    let browser: Browser;
    let server: Server;
    let origin = "";

    beforeAll(async () => {
        const bundle = readFileSync(bundlePath, "utf8");
        server = createServer((req, res) => {
            const u = req.url ?? "/";
            if (u === "/rewriter.js") {
                res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
                return res.end(bundle);
            }
            if (u.startsWith("/cyrano/https/site.example/page")) {
                const boot = `<script src="/rewriter.js"></script><script>window.$rewriter=window.$rewriter_init(window,{apiBaseURL:location.origin,source:"/rewriter.js"}).inject();$rewriter.set_location("https://site.example/page");</script>`;
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(`<!doctype html><html><head>${boot}</head><body></body></html>`);
            }
            if (u === "/direct") {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(`<!doctype html><html><head></head><body></body></html>`);
            }
            res.writeHead(204);
            return res.end();
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
    });

    // The tree a document written in these chunks makes (open, the writes, close).
    const splitShapes = async (url: string, chunks: string[][]): Promise<string[]> => {
        const page = await browser.newPage();
        await page.goto(url);
        const out = await page.evaluate((list: string[][]) => {
            const walk = (n: Node, rawParent: boolean): string => {
                if (n.nodeType === 10) return `<!DOCTYPE ${(n as DocumentType).name}>`;
                if (n.nodeType === 8) return `<!--${(n as Comment).data}-->`;
                if (n.nodeType === 3 || n.nodeType === 4) return rawParent ? "#" : JSON.stringify((n as Text).data);
                if (n.nodeType === 1) {
                    const e = n as Element;
                    if (e.localName === "script" && (((e.getAttribute("src") ?? "").endsWith("/rewriter.js")) || (e.textContent ?? "").includes("$rewriter"))) return "";
                    const names = Array.from(e.attributes).map((a) => a.name).filter((a) => a !== "crn-o" && !a.startsWith("data-crn")).sort();
                    const raw = e.localName === "script" || e.localName === "style";
                    return `<${e.localName} ${names.join(" ")}>${Array.from(e.childNodes).map((c) => walk(c, raw)).join("")}</>`;
                }
                return Array.from(n.childNodes).map((c) => walk(c, false)).join("");
            };
            return list.map((cs) => {
                const f = document.createElement("iframe");
                document.body.appendChild(f);
                const d = f.contentDocument!;
                d.open();
                for (const c of cs) d.write(c);
                d.close();
                const w = walk(d, false);
                f.remove();
                return w;
            });
        }, chunks);
        await page.close();
        return out;
    };

    const shapes = async (url: string, ms: string[]): Promise<Shape[]> => {
        const page = await browser.newPage();
        await page.goto(url);
        const out = await page.evaluate(async (list: string[]) => {
            const NS: Record<string, string> = { "http://www.w3.org/1999/xhtml": "", "http://www.w3.org/2000/svg": "svg:", "http://www.w3.org/1998/Math/MathML": "math:" };
            const isBoot = (n: Node): boolean => n.nodeType === 1 && (n as Element).localName === "script" &&
                (((n as Element).getAttribute("src") ?? "").endsWith("/rewriter.js") || (n.textContent ?? "").includes("$rewriter"));
            const walk = (n: Node, rawParent: boolean): string => {
                if (n.nodeType === 10) return `<!DOCTYPE ${(n as DocumentType).name}>`;
                if (n.nodeType === 8) return `<!--${(n as Comment).data}-->`;
                if (n.nodeType === 3 || n.nodeType === 4) return rawParent ? "#" : JSON.stringify((n as Text).data);
                if (n.nodeType === 1) {
                    const e = n as Element;
                    if (isBoot(e)) return "";
                    const names = Array.from(e.attributes).map((a) => a.name).filter((a) => a !== "crn-o" && !a.startsWith("data-crn")).sort();
                    const raw = e.localName === "script" || e.localName === "style";
                    const kids = Array.from((e as HTMLTemplateElement).content?.childNodes ?? e.childNodes).map((c) => walk(c, raw)).join("");
                    return `<${NS[e.namespaceURI ?? ""] ?? "?:"}${e.localName} ${names.join(" ")}>${kids}</>`;
                }
                return Array.from(n.childNodes).map((c) => walk(c, false)).join("");
            };
            const results: { write: string; srcdoc: string; inner: string }[] = [];
            for (const m of list) {
                const f = document.createElement("iframe");
                document.body.appendChild(f);
                const d = f.contentDocument!;
                d.open();
                d.write(m);
                d.close();
                const write = walk(d, false) + " " + d.compatMode;
                f.remove();
                const g = document.createElement("iframe");
                const loaded = new Promise<void>((r) => g.addEventListener("load", () => r(), { once: true }));
                g.srcdoc = m;
                document.body.appendChild(g);
                await Promise.race([loaded, new Promise((r) => setTimeout(r, 1000))]);
                const srcdoc = g.contentDocument ? walk(g.contentDocument, false) + " " + g.contentDocument.compatMode : "no document";
                g.remove();
                const div = document.createElement("div");
                div.innerHTML = m;
                results.push({ write, srcdoc, inner: walk(div, false) });
            }
            return results;
        }, ms);
        await page.close();
        return out;
    };

    it("document.write, srcdoc and innerHTML", async () => {
        const draws = fc.sample(fc.oneof(markupArb(12), documentArb()), { numRuns: 250, seed });
        const direct = await shapes(`${origin}/direct`, draws);
        const proxied = await shapes(`${origin}/cyrano/https/site.example/page`, draws);
        const bad: string[] = [];
        for (let k = 0; k < draws.length; k++) {
            for (const how of ["write", "srcdoc", "inner"] as const) {
                if (direct[k]![how] !== proxied[k]![how]) bad.push(`${how} ${JSON.stringify(draws[k])}\n  proxied ${proxied[k]![how]}\n  direct  ${direct[k]![how]}`);
            }
        }
        expect(bad.slice(0, 8), `${bad.length} differ (seed ${seed})`).toEqual([]);
    }, 300_000);

    // Each write was tokenized from the data state: a tag or script split
    // across writes went to the browser unrewritten (wrappers/document-write.ts
    // keeps the unfinished tail for the next write).
    it("markup split across writes makes the direct tree", async () => {
        const draws = fc.sample(fc.tuple(fc.oneof(markupArb(10), documentArb()), fc.array(fc.nat(1000), { maxLength: 4 }))
            .map(([m, cuts]) => {
                const at = [...new Set(cuts.map((c) => c % (m.length + 1)))].sort((a, b) => a - b);
                const out: string[] = [];
                let prev = 0;
                for (const c of at) { out.push(m.slice(prev, c)); prev = c; }
                out.push(m.slice(prev));
                return out;
            }), { numRuns: 200, seed });
        // Found by seed 390681823: past a <plaintext> start tag split across
        // writes, every later write is text (it was rewritten as markup).
        draws.push(["<plainte", "xt data-i=1>a<b data-i=2>", "<img data-i=3 src=x/>", "<script>x</script>"]);
        const direct = await splitShapes(`${origin}/direct`, draws);
        const proxied = await splitShapes(`${origin}/cyrano/https/site.example/page`, draws);
        const bad: string[] = [];
        for (let k = 0; k < draws.length; k++) if (direct[k] !== proxied[k]) bad.push(`${JSON.stringify(draws[k])}\n  proxied ${proxied[k]}\n  direct  ${direct[k]}`);
        expect(bad.slice(0, 6), `${bad.length} differ (seed ${seed})`).toEqual([]);
    }, 300_000);

    it("nothing a written document loads escapes the proxy; chunked writes stay open", async () => {
        const page = await browser.newPage();
        const escaped: string[] = [];
        page.on("request", (r) => {
            const u = r.url();
            if (/^https?:/.test(u) && !u.startsWith(origin)) escaped.push(u);
        });
        await page.goto(`${origin}/cyrano/https/site.example/page`);
        const seen = await page.evaluate(async () => {
            const E = "https://ads.example/";
            const docs = [
                `<frameset><frame src="${E}w-frame"></frameset>`,
                `<body background="${E}w-body.png"><p>x`,
                `<svg><style><image href="${E}w-svgstyle.png"/></style></svg>`,
                `<svg><title><a href="${E}w-svgtitle">t</a></title></svg><img src="${E}w-img.png">`,
                `<math><mi><img src="${E}w-mathml.png"></mi></math>`,
                `<table><td background="${E}w-td.png">c</td></table>`,
                `<img src="${E}w-a&amp;b.png" srcset="${E}w-s1.png 1x, ${E}w-s2.png 2x">`,
                `<noscript><img src="${E}w-noscript.png"></noscript><p>after`,
                `<meta http-equiv="refresh" content="0; url=${E}w-refresh">`,
            ];
            for (const d of docs) {
                const f = document.createElement("iframe");
                document.body.appendChild(f);
                f.contentDocument!.open();
                f.contentDocument!.write(d);
                f.contentDocument!.close();
                const g = document.createElement("iframe");
                g.srcdoc = d;
                document.body.appendChild(g);
                // (A refresh in this page itself would navigate it away.)
                if (d.includes("refresh")) continue;
                const div = document.createElement("div");
                div.innerHTML = d;
                document.body.appendChild(div);
            }
            // A refresh built through the DOM, content before http-equiv.
            const rf = document.createElement("iframe");
            document.body.appendChild(rf);
            const rm = rf.contentDocument!.createElement("meta");
            rm.setAttribute("content", `0;url=${E}w-refresh-dom`);
            rm.setAttribute("http-equiv", "refresh");
            rf.contentDocument!.head.appendChild(rm);
            // The SVG context: innerHTML of an svg element.
            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            document.body.appendChild(svg);
            svg.innerHTML = `<image href="${E}w-svg-inner.png"/>`;
            // A chunked write leaves the element open, as directly.
            const c = document.createElement("iframe");
            document.body.appendChild(c);
            const cd = c.contentDocument!;
            cd.open();
            cd.write('<div id="a">');
            cd.write(`<img src="${E}w-chunk.png">`);
            cd.write("text</div><p>after</p>");
            cd.close();
            // A tag and a script split across writes.
            const sp = document.createElement("iframe");
            document.body.appendChild(sp);
            const sd = sp.contentDocument!;
            sd.open();
            sd.write(`<img sr`);
            sd.write(`c="${E}w-split-img.png"><scr`);
            sd.write(`ipt src="${E}w-split.js"></scr`);
            sd.write("ipt><script>new Image().src = ");
            sd.write(`"${E}w-split-inline.png"</script>`);
            sd.close();
            // A noscript's content is the page's text.
            const n = document.createElement("div");
            n.innerHTML = `<noscript><img src="${E}w-ns.png" data-x=1></noscript>`;
            await new Promise((r) => setTimeout(r, 800));
            return {
                chunk: cd.getElementById("a")?.innerHTML ?? null,
                noscript: n.firstElementChild!.textContent,
                svgNs: svg.firstElementChild?.namespaceURI ?? null,
            };
        }, undefined);
        await page.waitForTimeout(500);
        await page.close();
        expect(escaped).toEqual([]);
        expect(seen).toEqual({
            chunk: '<img src="https://ads.example/w-chunk.png">text',
            noscript: '<img src="https://ads.example/w-ns.png" data-x=1>',
            svgNs: "http://www.w3.org/2000/svg",
        });
    }, 60_000);
});
