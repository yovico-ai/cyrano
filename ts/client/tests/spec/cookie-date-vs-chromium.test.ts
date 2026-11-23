// @vitest-environment node
//
// spec/CookieDate.agda `cookieDate` against Chromium: each string is set as
// a cookie's Expires through document.cookie, and cookieStore.get reports
// the expiry the browser stored — none (a session cookie: no date), the
// cookie gone (a date in the past), capped at 400 days, or the instant. The
// spec's answer must say the same of every string, the fixed ones measured
// by hand (2026-11-23) and generated runs of date-like pieces.
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

const FIXED = ["Wed, 21 Oct 2026 07:28:00 GMT", "21 Oct 2027 07:28:00", "Oct 21 2027 7:28:0", "2027 Oct 21 07:28:00", "21-Oct-27 07:28:00",
    "21-Oct-69 07:28:00", "21-Oct-70 07:28:00", "21 Oct 1601 00:00:00", "21 Oct 1600 00:00:00", "30 Feb 2027 00:00:00", "31 Apr 2027 00:00:00",
    "32 Oct 2027 00:00:00", "21 Oct 2027 24:00:00", "21 Oct 2027 23:60:00", "21 Oct 2027 23:59:60", "21 October 2027 07:28:00", "21 Okt 2027 07:28:00",
    "21 Oct 2027", "Oct 2027 07:28:00", "21 Oct 07:28:00", "1 Jan 10000 00:00:00", "1 Jan 9999 23:59:59", "1 jan 2027 1:2:3", "1x Jan 2027 1:2:3",
    "001 Jan 2027 00:00:00", "1 Jan 02027 00:00:00", "1 Jan 2027 001:02:03", "1 Jan 2027 1:2:3x", "1 Jan 2027 1:2", "Jan1 2027 00:00:00",
    "1 Jan 27", "1 Jan 2027 00:00:00 +0500", "Thu Jan 01 2037 00:00:00", "Sat, 01-Jan-2050 00:00:00 GMT", "1 Jan 99999 0:0:0", "29 Feb 2028 0:0:0",
    "29 Feb 2027 0:0:0", "  ", "30 Feb 30000 0:0:0", "30 Feb 1500 0:0:0", "1 Jan 2027 0:0:0 1 2", "1 Jan 2027 0:0:0 Feb", "Jan Feb 1 2027 0:0:0",
    "1 2027 Jan 0:0:0", "2027 1 Jan 0:0:0", "1:2:3 1 Jan 2027", "9:99:9 1:2:3 1 Jan 2027", "1 Jan 2027 0:0:0é", "1é Jan 2027 0:0:0",
    "Janué 1 2027 0:0:0", "01 Jan 0 0:0:0", "01 Jan 069 0:0:0", "01 Jan 070 0:0:0", "01 Jan 100 0:0:0", "1:Jan 2027 0:0:0",
    "1 Jan 2027 0:0:0.5", "0 Jan 2027 0:0:0", "1 Jan 2027 99:0:0 1:2:3", "1 Jan 1970 0:0:0", "31 Dec 1969 23:59:59",     "15/Mar/2027/10:11:12", "15.Mar.2027 10:11:12", "15 MAR 2027 10:11:12", "15 mar. 2027 10:11:12", "31 Dec 2027 23:59:59", "1 Dec 2027 0:0:0"];
// Generated: runs of the pieces the reader looks at (no ";": it ends the
// attribute; no tab: one inside an attribute value rejects the cookie).
const PIECES = [" ", "-", ",", "/", "1", "15", "31", "29", "0", "2027", "27", "99", "1999", "12345", "Feb", "jun", "Sept", "x",
    "Mon", "GMT", "10:11:12", "1:2:3", "23:59:60", "9:9", "123:4:5", "12x", ":", "é"];
function generated(n: number): string[] {
    let seed = 11;
    const rnd = (k: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
        let s = "";
        for (let j = 2 + rnd(7); j > 0; j--) s += PIECES[rnd(PIECES.length)] + (rnd(3) === 0 ? "" : " ");
        out.push(s);
    }
    return out;
}
const DATES = [...FIXED, ...generated(500)];

describe.skipIf(!wanted || located.skip !== "")("a cookie's Expires date: the spec is Chromium", () => {
    let oracle: OracleClient;
    let browser: Browser;
    let server: Server;

    beforeAll(async () => {
        oracle = new OracleClient(located.path);
        server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>d</title>"); });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
        const { chromium } = require("playwright") as { chromium: { launch(o?: object): Promise<Browser> } };
        browser = await chromium.launch();
    });
    afterAll(async () => {
        await browser?.close();
        server?.close();
        oracle?.close();
    });

    it("every string is read as the spec reads it", async () => {
        const page = await browser.newPage();
        // localhost: a secure context, so cookieStore is there.
        await page.goto(`http://localhost:${(server.address() as { port: number }).port}/`);
        const got = await page.evaluate(async (ds: string[]) => {
            const out: { now: number; r: (number | "gone" | "session")[] } = { now: Date.now(), r: [] };
            for (let i = 0; i < ds.length; i++) {
                document.cookie = `c${i}=1; expires=${ds[i]}`;
                const c = await cookieStore.get(`c${i}`);
                const e = c === null ? null : (c as { expires?: number | null }).expires ?? null;
                out.r.push(c === null ? "gone" : e === null ? "session" : e);
                if (c !== null) document.cookie = `c${i}=; max-age=0`;
            }
            return out;
        }, DATES);
        await page.close();
        const cap = got.now + 400 * 86400 * 1000;
        const bad: string[] = [];
        for (let i = 0; i < DATES.length; i++) {
            const a = await oracle.ask("cookiedate", [DATES[i]!]);
            const want = a === "none" ? "session" : Number(a) * 1000 <= got.now ? "gone" : Number(a) * 1000 > cap ? "capped" : Number(a) * 1000;
            const r = got.r[i]!;
            const have = typeof r === "number" && Math.abs(r - cap) < 60_000 ? "capped" : r;
            if (have !== want) bad.push(`${JSON.stringify(DATES[i])}: Chromium ${have}, spec ${want}`);
        }
        expect(bad).toEqual([]);
    }, 300_000);
});
