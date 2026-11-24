// @vitest-environment node
//
// Conformance of the runtime's muting of error events
// (src/patches/error-events.ts scriptMuted) with spec/ErrorEvents.agda. Its
// effect in Chromium: tests/native/error-events-vs-chromium.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { locationIn, scriptMuted } from "../../src/patches/error-events";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

describe.skipIf(located.skip !== "")("error events: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("scriptMuted is ErrorEvents.muted", async () => {
        for (const same of [true, false]) for (const cors of [true, false]) for (const mod of [true, false]) {
            const spec = await oracle.ask("errmuted", [same ? "same" : "cross", cors ? "cors" : "nocors", mod ? "module" : "classic"]);
            expect(scriptMuted(same, cors, mod) ? "yes" : "no").toBe(spec);
        }
    });

    it("locationIn takes the first frame in the script", () => {
        const stack = "Error: x\n    at f (https://a.example/lib.js:3:9)\n    at https://a.example/thr.js?k=1:1:32\n    at g (https://a.example/thr.js?k=1:5:2)";
        expect(locationIn(stack, "https://a.example/thr.js?k=1")).toEqual([1, 32]);
        expect(locationIn(stack, "https://a.example/lib.js")).toEqual([3, 9]);
        expect(locationIn(stack, "https://b.example/x.js")).toBeNull();
    });
});
