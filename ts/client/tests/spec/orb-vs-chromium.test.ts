// @vitest-environment node
//
// spec/Orb.agda `blocks` against Chromium: a <script> to another origin,
// of many Content-Types and bodies, with and without nosniff, fails
// exactly when the spec blocks it or the same response fails
// same-origin. Through the proxy every script is same-origin; the proxy
// fails the response where `orbproxy` says (no-cors: no crossorigin
// here), so proxied it fails exactly where it fails directly.
//
// Bodies run same-origin: none of them may loop.
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

// null: no Content-Type header.
const TYPES: (string | null)[] = [null, "", "foo", ";", "text/plain", "TEXT/Plain; charset=utf-8", "application/json", "text/json",
    "application/ld+json", "text/html", "text/xml", "application/xml", "application/octet-stream", "foo/bar",
    "application/javascript", "text/javascript", "text/css", "text/vtt", "application/dash+xml", "application/pdf",
    "application/zip", "application/x-protobuf", "multipart/byteranges", "text/event-stream", "text/plain, application/pdf",
    "application/pdf, text/plain"];

const FIXED = ['{"a":1}', '{ "a":1}', '{"a" :1}', "{'a':1}", "{a:1}", "{}", '{"a"}', "[1]", '"x"', ")]}'\n1", " )]}'1", "{}&&1", "{} &&1",
    "{}  &&1", "{}& &1", "<!doctype html>", "<!DOCTYPE HTML>", "<!doctype  html>", "<!doctype htmlx", "<html", "<Html>", "<head>",
    "<h1>", "<h2>", "<script>", "<iframe>", "<div>", "<font>", "<table>", "<a>", "<abbr>", "<style>", "<title>", "<b>", "<bra>",
    "<body>", "<br>", "<p>", "<pre>", "<span>", "<!-- x --><p>", "<!-- x -->\n<p>", "<!-- x -->\r<p>", "<!-- x -->\r\n<html>",
    "<!-- x -->  <html>", "<!-- a -->\n<!-- b -->\n<p>", "<!---->\n<html>", "<!--", "<!-- x -->", "<?xml", "<?XML", "  <?xml",
    "\v<p>", "\f<p>", "\r<p>", " \t\n<p>", "ï»¿<p>", 'ï»¿{"a":1}', "x<html>", "1;<html>",
    "// c\n<html>", "window.ran=1", "", '{"a\\"b":1}', '{"":1}', '{"a":', '{"a"', '{\v"a":1}', '{\n"a"\n:1}',
    " ".repeat(1020) + "<p>", " ".repeat(1022) + "<p>", " ".repeat(1023) + "<p>", "{" + " ".repeat(1020) + '"a":1}'];

// Generated: runs of the pieces the sniffers look at.
const PIECES = [" ", "\n", "\t", "\r", "<!-- c -->", "-->", "\n", "<p", "<P>", "<x>", "<?xml", "{", '"k"', ":", "1", "}", ")]}'", "&&", "<!--", "a"];
function generated(n: number): string[] {
    let seed = 7;
    const rnd = (k: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
        let s = "";
        for (let j = 1 + rnd(6); j > 0; j--) s += PIECES[rnd(PIECES.length)];
        out.push(s);
    }
    return out;
}
const BODIES = [...FIXED, ...generated(160)];

describe.skipIf(!wanted || located.skip !== "")("ORB of cross-origin scripts: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;
    let port = 0;

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((req, res) => {
            const u = new URL(req.url ?? "/", "http://x");
            if (u.pathname === "/m") {
                // a 301 whose body is HTML, to a script (adform's trackpoint)
                res.writeHead(301, { "Content-Type": "text/html", Location: "/s?t=text%2Fjavascript&b=" + BODIES.indexOf("window.ran=1") + "&ns=0" });
                res.end("<html><head><title>301 Moved Permanently</title></head></html>");
                return;
            }
            if (u.pathname === "/s") {
                const t = u.searchParams.get("t");
                if (t !== null) res.setHeader("Content-Type", t); else res.removeHeader("Content-Type");
                if (u.searchParams.get("ns") === "1") res.setHeader("X-Content-Type-Options", "nosniff");
                res.end(Buffer.from(BODIES[Number(u.searchParams.get("b"))]!, "latin1"));
                return;
            }
            res.setHeader("Content-Type", "text/html");
            res.end("<!doctype html><title>orb</title>");
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

    it("a redirect is followed, not judged: directly and proxied", async () => {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${port}/`);
        const ran = await page.evaluate((u: string) => new Promise<boolean>((done) => {
            const s = document.createElement("script");
            s.src = u;
            s.onload = () => done(true);
            s.onerror = () => done(false);
            document.head.appendChild(s);
        }), `http://localhost:${port}/m`);
        await page.close();
        expect(ran).toBe(true);
        const html = "<html><head><title>301 Moved Permanently</title></head></html>";
        expect(await oracle.ask("orbblocks", ["text/html", html])).toBe("yes"); // the 301's own body would be blocked
        expect(await oracle.ask("orbproxy", ["1", "1", "text/html", "1", html])).toBe("no"); // but the proxy lets the redirect through
    }, 60_000);

    it("blocks as the spec says; proxied as directly", async () => {
        const cases: { t: string | null; b: number; ns: boolean }[] = [];
        for (const t of TYPES) for (let b = 0; b < BODIES.length; b++) for (const ns of [false, true]) cases.push({ t, b, ns });
        const urls = (host: string): string[] => cases.map((c) => `http://${host}:${port}/s?${c.t === null ? "" : `t=${encodeURIComponent(c.t)}&`}b=${c.b}&ns=${c.ns ? 1 : 0}`);
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${port}/`);
        const load = (list: string[]): Promise<boolean[]> => page.evaluate(async (us: string[]) => {
            window.onerror = () => true;
            const one = (u: string): Promise<boolean> => new Promise((done) => {
                const s = document.createElement("script");
                s.src = u;
                s.onload = () => { s.remove(); done(true); };
                s.onerror = () => { s.remove(); done(false); };
                document.head.appendChild(s);
            });
            const out: boolean[] = [];
            for (let i = 0; i < us.length; i += 40) out.push(...await Promise.all(us.slice(i, i + 40).map(one)));
            return out;
        }, list);
        const same = await load(urls("127.0.0.1"));
        const cross = await load(urls("localhost"));
        await page.close();
        const bad: string[] = [];
        let blocked = 0;
        for (let i = 0; i < cases.length; i++) {
            const c = cases[i]!;
            const ct = c.t === null ? "-" : c.t;
            const spec = (await oracle.ask("orbblocks", [ct, BODIES[c.b]!])) === "yes";
            const proxyFails = (await oracle.ask("orbproxy", ["1", "0", ct, "1", BODIES[c.b]!])) === "yes";
            if (spec && same[i]) blocked++;
            const where = `${JSON.stringify(c.t)}${c.ns ? " nosniff" : ""} ${JSON.stringify(BODIES[c.b]!.slice(0, 40))}`;
            if (cross[i] !== (same[i]! && !spec)) bad.push(`${where}: Chromium cross-origin ${cross[i] ? "runs" : "fails"}, same-origin ${same[i] ? "runs" : "fails"}, spec ${spec ? "blocks" : "does not"}`);
            if ((same[i]! && !proxyFails) !== cross[i]) bad.push(`${where}: proxied ${same[i] && !proxyFails ? "runs" : "fails"}, directly ${cross[i] ? "runs" : "fails"}`);
        }
        expect(bad).toEqual([]);
        expect(blocked).toBeGreaterThan(200); // the check decided something
    }, 600_000);
});
