// @vitest-environment node
//
// Conformance of the runtime's postMessage delivery decision
// (src/messaging/target-origin.ts delivery) with spec/Messaging.agda. A
// call left to the native is right where the native decides as the spec
// says: "*", a SyntaxError, a file:/ftp: origin (post-message-vs-chromium
// checks those natively).

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { delivery } from "../../src/messaging/target-origin";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const ORIGINS = ["https://a.example", "https://b.example:8443", "http://c.example"];
const TARGETS = ["*", "/", "https://a.example", "https://a.example:443/p?q#f", "https://u:p@b.example:8443/x", "HTTPS://A.EXAMPLE", "  https://a.example  ",
    "blob:https://a.example/uuid", "BLOB:http://c.example/u", "blob:nope", "data:x", "nope", "https://", "a.example", "javascript:x", "http://a.example",
    "wss://a.example", "", " ", "*/", "file:///x", "ftp://x", "https://b.example:8443"];

describe.skipIf(located.skip !== "")("postMessage delivery: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("delivery is delivery", async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom(...ORIGINS), fc.constantFrom(...ORIGINS), fc.constantFrom(...TARGETS), async (sender, recipient, t) => {
            const win = { $rewriter: { get_base_url: () => new URL(recipient + "/page") } };
            const d = delivery(win, t, sender, "http://proxy:1", (h) => h);
            const want = await oracle.ask("postdelivery", [sender, recipient, t]);
            const lower = t.trim().toLowerCase();
            const nativeDecides = t === "*" || want === "throw" || lower.startsWith("file:") || lower.startsWith("ftp:");
            const got = d.kind === "send" ? "deliver" : d.kind === "drop" ? "drop" : nativeDecides ? want : "native";
            expect(got, `${sender} → ${recipient} ${JSON.stringify(t)}`).toBe(want);
        }), { numRuns: 1500 });
    });
});
