// @vitest-environment node
//
// Conformance of src/patches/cors.ts with spec/Fetch.agda, asked live:
// the credentials decision, the CORS check and the exposed headers. (The
// spec itself is checked against Chromium in fetch-vs-chromium.test.ts.)
//
// TS sees a header as Headers.get gives it — the field lines joined by
// ", " — so the runtime's input is built that way from the drawn lines.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { corsAllows, exposedBy, includesCredentials } from "../../src/patches/cors";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const ORIGIN = "https://a.example";
// Field values as the browser hands them over: HTTP parsing has already
// trimmed space and tab around each line.
const originVals = ["*", ORIGIN, `${ORIGIN}/`, "https://A.example", "null", "*, " + ORIGIN, `${ORIGIN}\v`, "https://a.example:443"];
const credVals = ["true", "True", "false", "true, true", "true\v"];
const exposeVals = ["*", "X-Foo", "x-foo, x-bar", "X-FOO , *", "x-bar\t", "X-Foo X-Bar", "x-foo,,x-bar", "\vx-foo", "x-foo\v",
    "set-cookie", ",", "x-star;q=1", "\"x-foo\"", "content-type", "é"];
const names = ["x-foo", "X-Bar", "content-language", "x-star", "set-cookie", "*", "content-type"];

// Headers.get: the lines joined by ", ", or null.
const joined = (lines: string[]): string | null => (lines.length ? lines.join(", ") : null);

describe.skipIf(located.skip !== "")("fetch / CORS: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("includesCredentials", async () => {
        for (const mode of ["omit", "same-origin", "include"]) {
            for (const same of [true, false]) {
                const want = (await oracle.ask("credentials", [mode, same ? "same" : "cross"])) === "yes";
                expect(includesCredentials(mode, same), `${mode} ${same}`).toBe(want);
            }
        }
    });

    it("corsAllows", async () => {
        await fc.assert(fc.asyncProperty(
            fc.array(fc.constantFrom(...originVals), { minLength: 1, maxLength: 2 }),
            fc.array(fc.constantFrom(...credVals), { maxLength: 2 }),
            fc.boolean(),
            async (ao, ac, cred) => {
                const want = (await oracle.ask("cors", [ORIGIN, cred ? "cred" : "nocred", ao.join("\n"), ac.join("\n")])) === "yes";
                expect(corsAllows(joined(ao), joined(ac), ORIGIN, cred), JSON.stringify({ ao, ac, cred })).toBe(want);
            },
        ), { numRuns: 200 });
    });

    it("exposedBy", async () => {
        await fc.assert(fc.asyncProperty(
            fc.array(fc.constantFrom(...exposeVals), { minLength: 1, maxLength: 3 }),
            fc.boolean(),
            fc.constantFrom(...names),
            async (lines, cred, name) => {
                const want = (await oracle.ask("expose", [cred ? "cred" : "nocred", lines.join("\n"), name])) === "yes";
                expect(exposedBy(joined(lines), cred)(name), JSON.stringify({ lines, cred, name })).toBe(want);
            },
        ), { numRuns: 300 });
    });
});
