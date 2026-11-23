// @vitest-environment node
//
// Conformance of src/cookies/rfc.ts with spec/Cookies.agda, asked live.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cookiesFor, parseSetCookie, storeCookie, unwire, wireName, wireValue, type StoredCookie } from "../../src/cookies/rfc";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const names = ["a", "sid", "__Host-x", "__Secure-y", "__HOST-z", "", " sp ", "n!m", "é", "n\tm", "\tt\t"];
const values = ["1", "", "v=w", " padded ", "a b", "\"q\"", "__Host-v", "x;y", "a\tb", "\t1\t"];
const attrs = [
    "", "Path=/", "Path=/app", "Path=/app/", "path=nope", "Path=", "Path=/other", "Path=/é",
    "Domain=a.example", "Domain=.a.example", "Domain=www.a.example", "Domain=A.example", "Domain=b.example",
    "Domain=", "Domain=example", "Domain=sub.www.a.example", "Domain=1.2.3.4",
    "Secure", "secure", "HttpOnly", "SameSite=None", "SameSite=Lax", "SameSite=Strict", "SameSite=bogus",
    "Max-Age=60", "Max-Age=0", "Max-Age=-1", "Max-Age=abc", "Max-Age=", "Max-Age=-", "Unknown=1", " Secure ",
    "Expires=Wed, 21 Oct 2037 07:28:00 GMT", "Expires=", "\x01", "Path=/a\tb", "\tSecure", "Priority=High", "priority=low", "Priority=medium", "Priority=bogus", "Max-Age=\t60", "Foo=a\tb", "Expires=1 Jan\t2027 0:0:0",
];
const urls = [
    "https://www.a.example/app/page?x", "http://www.a.example/app/page", "https://a.example/", "https://www.a.example/app",
    "https://www.a.example/application", "https://sub.www.a.example/app/page", "https://b.example/app/page",
    "http://localhost:8080/app/x", "https://1.2.3.4/app/", "http://[::1]/", "https://www.a.example",
];
const cookieStr = fc.tuple(
    fc.constantFrom(...names), fc.constantFrom(...values), fc.boolean(),
    fc.array(fc.tuple(fc.constantFrom("", " "), fc.constantFrom(...attrs)), { maxLength: 4 }),
).map(([n, v, nameless, as]) => (n === "" && nameless ? v : `${n}=${v}`) + as.map(([sp, a]) => `;${sp}${a}`).join(""));

const opt = (v: string | null): string => (v === null ? "" : `=${v}`);

describe.skipIf(located.skip !== "")("cookies: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("set-cookie: parse, store, wire", async () => {
        await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.constantFrom(...urls), cookieStr, async (api, ps, page, s) => {
            const want = await oracle.ask("setcookie", [api ? "api" : "http", ps ? "ps" : "nops", page, s]);
            const sc = parseSetCookie(s);
            const c = sc && storeCookie(api, ps, new URL(page), sc);
            const got = !sc || !c ? null : [
                c.hostOnly ? "h" : "d", c.domain, c.path, c.name, c.value, c.secure ? "s" : "i",
                c.httpOnly ? "H" : "-", c.sameSite, opt(sc.maxAge), opt(sc.expires), wireName(c), wireValue(c), c.priority,
            ].join("\n");
            expect(got, `set-cookie ${JSON.stringify(s)} at ${page} (api=${api} ps=${ps})`).toBe(want);
            if (c && !/é/.test(c.domain + c.path)) {
                expect(unwire(wireName(c), wireValue(c))).toEqual({ ...c, httpOnly: false, priority: "M" }); // the legacy wire form carries no priority
            }
        }), { numRuns: 1500 });
    });

    it("cookies for a URL, from the jar", async () => {
        const stored = fc.tuple(cookieStr, fc.constantFrom(...urls)).map(([s, page]): StoredCookie | null => {
            const sc = parseSetCookie(s);
            const c = sc && storeCookie(false, false, new URL(page), sc);
            return c && !c.httpOnly ? c : null;
        });
        const jar = fc.tuple(fc.array(stored, { maxLength: 5 }), fc.constantFrom("other=1", "__crn!x!bad", "__crn!h!a.example!%2F!n=zz:1", "plain"))
            .map(([cs, foreign]) => [...cs.filter((c): c is StoredCookie => c !== null).map((c) => `${wireName(c)}=${wireValue(c)}`), foreign].join("; "));
        await fc.assert(fc.asyncProperty(fc.boolean(), fc.constantFrom(...urls), jar, async (api, page, j) => {
            const want = await oracle.ask("cookies", [api ? "api" : "http", page, j]);
            expect(cookiesFor(api, new URL(page), j), `cookies for ${page} (api=${api}) from ${JSON.stringify(j)}`).toBe(want);
        }), { numRuns: 1500 });
    });
});
