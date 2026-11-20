// @vitest-environment node
//
// Conformance of the toolbar's geometry (src/ui/toolbar.ts dragLeft,
// placeLeft, region) with spec/Toolbar.agda, asked live.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cursorOver, dragLeft, initialLeft, placeLeft, region, rightEnd } from "../../src/ui/toolbar";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

// Viewport-sized numbers, the edges among them.
const px = fc.oneof(fc.constantFrom(0, 1, 19, 20, 21, 22, 23, 24, 43, 44, 45, 71, 72, 73, 95, 96, 97, 1280), fc.nat(2000));

describe.skipIf(located.skip !== "")("Portal toolbar geometry: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("dragLeft, placeLeft and initialLeft", async () => {
        await fc.assert(fc.asyncProperty(px, px, px, px, px, async (vw, w, start, grab, now) => {
            expect(String(dragLeft(vw, w, start, grab, now)), JSON.stringify([vw, w, start, grab, now]))
                .toBe(await oracle.ask("toolbarleft", [vw, w, start, grab, now].map(String)));
            expect(String(placeLeft(vw, w, start))).toBe(await oracle.ask("toolbarplace", [vw, w, start].map(String)));
            expect(String(initialLeft(vw, w))).toBe(await oracle.ask("toolbarinitial", [vw, w].map(String)));
            expect(String(rightEnd(vw, w))).toBe(await oracle.ask("toolbarright", [vw, w].map(String)));
        }), { numRuns: 400 });
    });

    it("region and the cursor over it", async () => {
        await fc.assert(fc.asyncProperty(px, px, px, px, px, px, px, fc.boolean(), async (left, w, h, grip, jump, x, y, dragging) => {
            const r = region(left, w, h, grip, jump, x, y);
            expect(r, JSON.stringify([left, w, h, grip, jump, x, y])).toBe(await oracle.ask("toolbarregion", [left, w, h, grip, jump, x, y].map(String)));
            expect(cursorOver(dragging, r)).toBe(await oracle.ask("toolbarcursor", [dragging ? 1 : 0, left, w, h, grip, jump, x, y].map(String)));
        }), { numRuns: 500 });
    });
});
