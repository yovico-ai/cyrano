// @vitest-environment node
//
// "The spec is the browser", for spec/HtmlTok.agda against real Chromium:
//
//   * which start tags make elements, and in which namespace (`htmltags`):
//     a document parsed with scripting on (a page), DOMParser's and a
//     <template>'s with it off (the client's template parse);
//   * where the bootstrap goes (`bootat`): a probe put there runs before
//     every page script, removes itself, and the document is then what it
//     is directly (tree, compat mode, character set — also when the
//     bootstrap pushes <meta charset> past the first 1024 bytes).
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";
import { CONTEXTS, documentArb, markupArb } from "./html-gen";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";

type Page = { goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T, a: A): Promise<T>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void>; version(): string };

const seed = Number(process.env.CYRANO_SEED ?? Date.now() % 1e9);
const PROBE = `<script>(window.__o=window.__o||[]).push("boot");document.currentScript.remove()</script>`;

let served: { body: Buffer; type: string } = { body: Buffer.from(""), type: "text/html" };

describe.skipIf(!wanted || located.skip !== "")("HTML tokenization: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let ctx: Context;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((_req, res) => {
            res.writeHead(200, { "content-type": served.type });
            res.end(served.body);
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as { port: number }).port;
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(): Promise<Browser> } };
        browser = await chromium.launch();
        ctx = await browser.newContext();
    });
    afterAll(async () => {
        oracle?.close();
        await browser?.close();
        server?.close();
    });

    const load = async (body: string | Buffer, type = "text/html"): Promise<Page> => {
        served = { body: typeof body === "string" ? Buffer.from(body) : body, type };
        const page = await ctx.newPage();
        await page.goto(`http://127.0.0.1:${port}/p`);
        return page;
    };

    const specTags = async (scripting: boolean, m: string): Promise<Map<string, string>> => {
        const out = (await oracle.ask("htmltags", [scripting ? "1" : "0", m])) ?? "";
        const ids = new Map<string, string>();
        for (const line of out === "" ? [] : out.split("\n")) {
            const [, ns, id] = line.split(" ");
            if (id !== "-" && !ids.has(id!)) ids.set(id!, ns!);
        }
        return ids;
    };

    it("start tags and their namespaces", async () => {
        const draws = fc.sample(markupArb(), { numRuns: 400, seed });
        const page = await load("<!doctype html><body>");
        // Each draw parsed three ways: a page (written into a frame, so
        // scripting is on), DOMParser and a template (scripting off).
        const seen = await page.evaluate(async (ms: string[]) => {
            const nsOf = (e: Element): string =>
                e.namespaceURI === "http://www.w3.org/2000/svg" ? "svg" : e.namespaceURI === "http://www.w3.org/1998/Math/MathML" ? "math" : "html";
            const ids = (root: ParentNode): Record<string, string> => {
                const r: Record<string, string> = {};
                for (const e of Array.from(root.querySelectorAll("*"))) {
                    const id = e.getAttribute("data-i");
                    if (id !== null && !(id in r)) r[id] = nsOf(e);
                }
                return r;
            };
            const out: { doc: Record<string, string>; parser: Record<string, string>; template: Record<string, string> }[] = [];
            for (const m of ms) {
                const f = document.createElement("iframe");
                document.body.appendChild(f);
                const d = f.contentDocument!;
                d.open();
                d.write("<!doctype html><body>" + m);
                d.close();
                const doc = ids(d);
                f.remove();
                const parser = ids(new DOMParser().parseFromString("<!doctype html><body>" + m, "text/html"));
                const t = document.createElement("template");
                t.innerHTML = m;
                out.push({ doc, parser, template: ids(t.content) });
            }
            return out;
        }, draws);
        await page.close();
        const mismatches: string[] = [];
        let compared = 0;
        for (let k = 0; k < draws.length; k++) {
            const m = draws[k]!;
            for (const [scripting, view, got] of [[true, "page", seen[k]!.doc], [false, "DOMParser", seen[k]!.parser], [false, "template", seen[k]!.template]] as const) {
                const want = await specTags(scripting, m);
                compared += want.size;
                const diff: string[] = [];
                for (const [id, ns] of want) if (got[id] !== ns) diff.push(`${id}: spec ${ns}, Chromium ${got[id] ?? "no element"}`);
                for (const id of Object.keys(got)) if (!want.has(id)) diff.push(`${id}: spec no start tag, Chromium ${got[id]}`);
                if (diff.length) mismatches.push(`${view} ${JSON.stringify(m)}: ${diff.join("; ")}`);
            }
        }
        expect(mismatches.slice(0, 15), `${mismatches.length} mismatches (seed ${seed}, Chromium ${browser.version()})`).toEqual([]);
        // The draws do reach the interesting states.
        expect(compared).toBeGreaterThan(draws.length * 3);
    }, 300_000);

    it("start tags and namespaces in a context element (innerHTML)", async () => {
        const draws = fc.sample(fc.tuple(markupArb(), fc.constantFrom(...CONTEXTS)), { numRuns: 400, seed });
        const page = await load("<!doctype html><body>");
        const seen = await page.evaluate((ds: [string, (typeof CONTEXTS)[number]][]) => {
            const NSU: Record<string, string> = { html: "http://www.w3.org/1999/xhtml", svg: "http://www.w3.org/2000/svg", math: "http://www.w3.org/1998/Math/MathML" };
            const nsOf = (e: Element): string =>
                e.namespaceURI === NSU["svg"] ? "svg" : e.namespaceURI === NSU["math"] ? "math" : "html";
            return ds.map(([m, c]) => {
                const name = c.ns === "svg" && c.name === "foreignobject" ? "foreignObject" : c.name;
                const el = document.createElementNS(NSU[c.ns]!, name);
                if (c.encoding !== null) el.setAttribute("encoding", c.encoding);
                document.body.appendChild(el);
                el.innerHTML = m;
                const root: ParentNode = el.localName === "template" && el.namespaceURI === NSU["html"] ? (el as HTMLTemplateElement).content : el;
                const r: Record<string, string> = {};
                for (const e of Array.from(root.querySelectorAll("*"))) {
                    const id = e.getAttribute("data-i");
                    if (id !== null && !(id in r)) r[id] = nsOf(e);
                }
                el.remove();
                return r;
            });
        }, draws);
        await page.close();
        const mismatches: string[] = [];
        for (let k = 0; k < draws.length; k++) {
            const [m, c] = draws[k]!;
            // innerHTML in a document with a browsing context: scripting on
            // (a template's content: off).
            const sc = !(c.ns === "html" && c.name === "template");
            const out = (await oracle.ask("htmltagsin", [sc ? "1" : "0", c.ns, c.name, c.encoding ?? "-", m])) ?? "";
            const want = new Map<string, string>();
            for (const line of out === "" ? [] : out.split("\n")) {
                const [, ns, id] = line.split(" ");
                if (id !== "-" && !want.has(id!)) want.set(id!, ns!);
            }
            const got = seen[k]!;
            const diff: string[] = [];
            for (const [id, ns] of want) if (got[id] !== ns) diff.push(`${id}: spec ${ns}, Chromium ${got[id] ?? "no element"}`);
            for (const id of Object.keys(got)) if (!want.has(id)) diff.push(`${id}: spec no start tag, Chromium ${got[id]}`);
            if (diff.length) mismatches.push(`${c.ns}:${c.name}${c.encoding ? "[" + c.encoding + "]" : ""} ${JSON.stringify(m)}: ${diff.join("; ")}`);
        }
        expect(mismatches.slice(0, 15), `${mismatches.length} mismatches (seed ${seed})`).toEqual([]);
    }, 300_000);

    const snapshot = (page: Page) => page.evaluate(() => {
        const ser = new XMLSerializer();
        return {
            order: ((window as unknown as { __o?: unknown[] }).__o ?? []).join(","),
            tree: Array.from(document.childNodes).map((n) => ser.serializeToString(n)).join("|"),
            mode: document.compatMode,
            charset: document.characterSet,
        };
    }, undefined);

    it("the bootstrap runs first and leaves the document as direct", async () => {
        const draws = fc.sample(documentArb(), { numRuns: 300, seed });
        const mismatches: string[] = [];
        for (const doc of draws) {
            const placed = (await oracle.ask("bootat", ["\u0000BOOT\u0000", doc]))!;
            const proxied = placed.replace("\u0000BOOT\u0000", PROBE);
            const pd = await load(doc);
            const direct = await snapshot(pd);
            await pd.close();
            const pp = await load(proxied);
            const prox = await snapshot(pp);
            await pp.close();
            const scripts = direct.order === "" ? 0 : direct.order.split(",").length;
            const why: string[] = [];
            if (scripts > 0 && !prox.order.startsWith("boot")) why.push(`order ${prox.order}`);
            if (prox.order.replace(/^boot,?/, "") !== direct.order) why.push(`page scripts ${prox.order} vs ${direct.order}`);
            if (prox.tree !== direct.tree) why.push(`tree\n  ${prox.tree}\nvs\n  ${direct.tree}`);
            if (prox.mode !== direct.mode) why.push(`compatMode ${prox.mode} vs ${direct.mode}`);
            if (why.length) mismatches.push(`${JSON.stringify(doc)} → ${JSON.stringify(proxied)}: ${why.join("; ")}`);
        }
        expect(mismatches.slice(0, 10), `${mismatches.length} of ${draws.length} (seed ${seed})`).toEqual([]);
    }, 600_000);

    it("a long bootstrap does not hide <meta charset>", async () => {
        // windows-1251 text, declared only by <meta charset> after <head>.
        const pad = "/*" + "p".repeat(3000) + "*/";
        const probe = `<script>${pad}(window.__o=window.__o||[]).push("boot");document.currentScript.remove()</script>`;
        for (const doc of [
            "<!doctype html><html><head><meta charset=windows-1251><title>ï</title></head><body>ïðè",
            "<!doctype html><head><title>t</title><meta http-equiv=content-type content=\"text/html; charset=windows-1251\"></head><body>ï",
            "<html><meta charset=windows-1251><body>ï",
        ]) {
            const placed = (await oracle.ask("bootat", ["\u0000BOOT\u0000", doc]))!.replace("\u0000BOOT\u0000", probe);
            const bytes = (s: string) => Buffer.from(s, "latin1");
            const pd = await load(bytes(doc));
            const direct = await snapshot(pd);
            const dtext = await pd.evaluate(() => document.body?.textContent ?? "", undefined);
            await pd.close();
            const pp = await load(bytes(placed));
            const prox = await snapshot(pp);
            const ptext = await pp.evaluate(() => document.body?.textContent ?? "", undefined);
            await pp.close();
            expect({ charset: prox.charset, text: ptext }, doc).toEqual({ charset: direct.charset, text: dtext });
        }
    }, 60_000);
});
