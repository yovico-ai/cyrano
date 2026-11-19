// @vitest-environment node
//
// The WebSocket page-origin marker (src/patches/websocket.ts) against
// spec/WsOrigin.agda, asked live: the runtime writes the spec's marker,
// reads the URL back without it, and the spec's own split recovers the
// page's query and the origin from the marked query, whatever the page's
// query holds (Go: urlrewrite TestSpecConformance_WSOrigin).

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withPageOrigin, withoutPageOrigin } from "../../src/patches/websocket";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const pieces = ["a=1", "&", "b=", "__cyrano_ws_origin=", "__cyrano_ws_origin=x", "x__cyrano_ws_origin=1", "%26", "=", "c", "é", "%20"];
const origins = ["https://s.example", "http://o.example:8080", "https://xn--bcher-kva.example"];

describe.skipIf(located.skip !== "")("WebSocket origin marker: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("withPageOrigin writes the spec's marker; withoutPageOrigin takes it off; the spec's split recovers both", async () => {
        await fc.assert(fc.asyncProperty(fc.boolean(), fc.array(fc.constantFrom(...pieces), { maxLength: 5 }), fc.constantFrom(...origins), async (hasQ, ps, o) => {
            const q = ps.join("");
            const base = "ws://p.example/cyrano/wss/h.example/s";
            const page = hasQ ? `${base}?${q}` : base;
            const marked = withPageOrigin(page, o);
            const want = await oracle.ask("wsmark", [hasQ ? "1" : "0", q, o]);
            expect(marked, JSON.stringify(page)).toBe(base + want);
            expect(withoutPageOrigin(marked)).toBe(page);
            const split = await oracle.ask("wssplit", [want!.slice(1)]);
            expect(split).toBe(`${hasQ ? "1" : "0"}\t${hasQ ? q : ""}\t${encodeURIComponent(o)}`);
        }), { numRuns: 500 });
    });
});
