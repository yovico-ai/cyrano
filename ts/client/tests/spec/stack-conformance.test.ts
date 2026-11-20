// @vitest-environment node
//
// Conformance of the runtime's stack reading (src/native/error-stack.ts
// stackUrls) with spec/Stack.agda, over stacks made of V8's frame forms
// with odd names and URLs. The spec against V8: stack-vs-chromium.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evalOrigin, stackUrls, untag } from "../../src/native/error-stack";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const URLS = ["https://h.example/a.js", "http://h.example:8080/x/y.js?q=1:2:3", "https://h.example/a(b).js", "https://h.example/a)b(c.js", "blob:https://h.example/uuid",
    "file:///tmp/x.js", "https://h.example/p, q.js", "https://h.example/x.js#f:1:2", "data:text/javascript,1", "chrome-extension://abc/x.js", "https://h.example/é.js"];
const NAMES = ["f", "Object.<anonymous>", "new Foo", "async g", "Object.a(b", "x (y)", "f [as g]", "eval", "Array.map", "<anonymous>", "Promise.all", "a (https:"];

const loc: fc.Arbitrary<string> = fc.letrec<{ loc: string }>((tie) => ({
    loc: fc.oneof({ depthSize: "small", withCrossShrink: true },
        fc.tuple(fc.constantFrom(...URLS), fc.nat(999), fc.nat(999)).map(([u, l, c]) => `${u}:${l}:${c}`),
        fc.constantFrom(...URLS),
        fc.constantFrom("<anonymous>", "native", "index 0", "<anonymous>:1:2"),
        fc.tuple(fc.constantFrom(...NAMES), tie("loc"), fc.constantFrom("<anonymous>:1:1", "https://h.example/s.js:2:3")).map(([n, l, p]) => `eval at ${n} (${l}), ${p}`),
        fc.tuple(fc.constantFrom(...NAMES), tie("loc")).map(([n, l]) => `eval at ${n} (${l})`)),
})).loc;
const frame = fc.oneof(
    loc.map((l) => `    at ${l}`),
    loc.map((l) => `    at async ${l}`),
    fc.tuple(fc.constantFrom(...NAMES), loc).map(([n, l]) => `    at ${n} (${l})`),
    fc.constantFrom("Error: boom", "    at", "at https://h.example/top.js:1:1", "  not a frame (https://h.example/a.js:1:1)", ""));

describe.skipIf(located.skip !== "")("Stack URLs: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("stackUrls is stackUrls", async () => {
        await fc.assert(fc.asyncProperty(fc.array(frame, { maxLength: 8 }), async (lines) => {
            const st = lines.join("\n");
            const want = await oracle.ask("stackurls", [st]);
            expect(stackUrls(st).join("\n"), st).toBe(want);
        }), { numRuns: 500 });
    });

    it("evalOrigin and untag are the spec's", async () => {
        const TAGS = ["crn-fn-abc-1", "crn-fn-abc-12", "x"];
        await fc.assert(fc.asyncProperty(fc.constantFrom(...NAMES, ""), loc, async (name, l) => {
            expect(evalOrigin(name, l)).toBe(await oracle.ask("evalorigin", [name, l]));
        }), { numRuns: 200 });
        await fc.assert(fc.asyncProperty(fc.constantFrom(...TAGS), loc,
            fc.array(fc.oneof(fc.constantFrom(...TAGS), fc.constantFrom(":3:4", ")", "inner (", "eval at f (", "", ", ")), { maxLength: 6 }),
            async (tag, origin, parts) => {
                const s = parts.join("");
                expect(untag(tag, origin, s), s).toBe(await oracle.ask("untag", [tag, origin, s]));
            }), { numRuns: 400 });
    });
});
