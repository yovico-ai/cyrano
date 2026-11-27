// Conformance of the runtime's choice of a frame window's runtime
// (src/runtime/iframe-injection.ts frameRuntime) with spec/Frames.agda
// frameRuntime, over every input. Against Chromium:
// tests/native/pending-frame-vs-chromium.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { frameRuntime, type FrameDoc } from "../../src/runtime/iframe-injection";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

describe.skipIf(located.skip !== "")("Frame runtime: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("frameRuntime is the spec's for every window and document", async () => {
        for (const held of [false, true]) for (const doc of ["pending", "blank", "booted", "bare", "inert"] as FrameDoc[]) {
            expect(frameRuntime(held, doc), `${held} ${doc}`).toBe(await oracle.ask("frameruntime", [held ? "1" : "0", doc]));
        }
    });
});
