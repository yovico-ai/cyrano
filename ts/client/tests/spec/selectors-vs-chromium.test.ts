// @vitest-environment node
//
// spec/Selectors.agda against Chromium: an element holding a proxied URL
// (`rewrite`) is matched by the widened selector (`widenselector`) exactly
// when the page's selector matches the page's URL directly — for a page
// that writes the URL in one form, and a prefix or part that runs past the
// host (cut inside a host, the proxied URL has a "/" there: a known gap;
// so is a relative value in a *= or $= test, and a relative ^= prefix
// ending in "." of a path going on with "." — "." resolves to the
// directory, "../" to its parent). Scripts and stylesheets hold
// their URLs marked (`rewritemark`); a source's srcset holds one
// candidate (= and ^= of one URL are widened there).
//
// Needs the oracle and Playwright's Chromium; `make browser-check`.

import { createRequire } from "node:module";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OracleClient, locateOracle } from "./oracle-client";

const located = locateOracle();
const wanted = process.env.CYRANO_BROWSER === "1";
const seed = Number(process.env.CYRANO_SEED ?? Date.now() % 1e9);

type Page = { setContent(h: string): Promise<void>; goto(u: string): Promise<unknown>; evaluate<T, A>(f: (a: A) => T, a: A): Promise<T>; close(): Promise<void> };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };

const PROXY = "http://p.example:9081";
const BASE = "https://site.example/dir/page";
const URLS = ["https://cdn.example/lib/a.js", "https://cdn.example/lib/a-b.js", "https://cdn.example/lib/a.js?v=2#f", "http://h.example/x/y", "https://site.example/dir/b.css", "/root/c.js", "rel/d.js", "../up.js"];

describe.skipIf(!wanted || located.skip !== "")("Selectors on URL attributes: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        oracle?.close();
        await browser?.close();
    });

    it("the widened selector matches the proxied element as the page's matches the page's", async () => {
        const kase = fc.tuple(fc.constantFrom(...URLS), fc.constantFrom("=", "^=", "*=", "$=", "~=", "|="), fc.nat(40), fc.constantFrom(...URLS), fc.boolean(), fc.constantFrom("img", "a", "script", "link", "source"))
            .map(([o0, op0, cut, other, related, tag]) => {
                // A source's srcset holds one candidate, "URL 1x": only = and ^= are widened there.
                const o = o0;
                const op = tag === "source" && op0 !== "=" ? "^=" : op0;
                const attr = tag === "source" ? "srcset" : tag === "img" || tag === "script" ? "src" : "href";
                const abs = /^[a-z]+:/.test(o);
                const afterHost = abs ? o.indexOf("/", o.indexOf("//") + 2) : 0;
                let v = other;
                if (related) {
                    if (op === "=" || op === "~=") v = o;
                    else if (op === "|=") v = o.indexOf("-") > afterHost ? o.slice(0, o.lastIndexOf("-")) : o;
                    else if (op === "^=") v = o.slice(0, Math.min(o.length, afterHost + 1 + cut));
                    else if (op === "*=" && abs) v = o.slice(o.indexOf("//"), Math.min(o.length, afterHost + 1 + cut));
                    else if (op === "$=") v = o.slice(Math.max(0, o.length - 1 - cut));
                }
                if ((op === "*=" || op === "$=") && !/^[a-z]+:/.test(v) && !/^\/\//.test(v) && v.indexOf("/") !== -1 && !abs) v = other; // a relative value: the known gap
                return { o, op, v, attr, tag };
            })
            .filter(({ o, op, v }) => !((op === "*=" || op === "$=") && !/^[a-z]+:/.test(o) && o.endsWith(v)))
            .filter(({ o, op, v }) => !(op === "^=" && /(^|\/)\.$/.test(v) && o.startsWith(v + ".")));
        const draws = fc.sample(kase, { numRuns: 200, seed });
        const rows: { o: string; held: string; sel: string; wide: string; attr: string; tag: string }[] = [];
        for (const { o, op, v, attr, tag } of draws) {
            const sel = `[${attr}${op}"${v.replace(/"/g, '\\"')}"]`;
            const mark = tag === "script" ? "js" : tag === "link" ? "css" : "-";
            const held = (await oracle.ask("rewritemark", [PROXY, BASE, "-", mark, o]))!;
            rows.push({ o, held, sel, wide: (await oracle.ask("widenselector", [PROXY, BASE, sel]))!, attr, tag });
        }
        const page = await browser.newPage();
        await page.setContent("<!doctype html><title>s</title>");
        const got = await page.evaluate((rs: typeof rows) => rs.map((r) => {
            const tag = r.tag;
            const cand = r.attr === "srcset" ? " 1x" : "";
            const direct = document.createElement(tag); direct.setAttribute(r.attr, r.o + cand);
            const proxied = document.createElement(tag); proxied.setAttribute(r.attr, r.held + cand);
            return [direct.matches(r.sel), proxied.matches(r.wide)];
        }), rows);
        await page.close();
        const bad: string[] = [];
        let matched = 0;
        rows.forEach((r, k) => {
            const [d, p] = got[k]!;
            if (d) matched++;
            if (d !== p) bad.push(`${r.tag}${r.sel} on ${r.o} (held ${r.held}): direct ${d}, widened ${p} (${r.wide})`);
        });
        expect(bad.slice(0, 12), `${bad.length} (seed ${seed})`).toEqual([]);
        expect(matched).toBeGreaterThan(20);
    }, 120_000);
});
