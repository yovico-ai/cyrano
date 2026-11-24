// @vitest-environment node
//
// Conformance of the runtime's storage naming (src/patches/storage.ts
// namePrefix / storedName / shownName) with spec/Storage.agda, and of its
// localStorage quota decision (src/patches/local-store.ts fitsQuota, and
// the Partition that keeps a running size) with spec/LocalStore.agda fits.
// The isolation of partitions — a name stored under one key is never read
// under another — is checked here by property (the spec proves only the
// round trip).

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lockName, namePrefix, opfsDirName, shownName, storedName } from "../../src/patches/storage";
import { Partition, QUOTA, fitsQuota, type NativeStorage } from "../../src/patches/local-store";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

// Storage keys as partitionKey makes them: an origin, or origin ^ site.
const KEYS = ["https://one.com", "https://www.one.com", "https://one.com^https://two.com", "http://two.com", "https://a.github.io", "http://127.0.0.1:8", "https://one.co", "https://one.com.evil"];
const name = fc.string({ maxLength: 12, unit: fc.constantFrom("a", "b", "^", "\u001f", "é", "/", " ", "😀") });

describe.skipIf(located.skip !== "")("storage names and localStorage quota: spec conformance", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("a name is stored as the spec stores it, and reads back", async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom(...KEYS), name, async (k, n) => {
            expect(storedName(k, n)).toBe(await oracle.ask("storename", [k, n]));
            expect(shownName(k, storedName(k, n))).toBe(n);
        }), { numRuns: 300 });
    });

    it("a key's OPFS root is the directory the spec names", async () => {
        for (const k of [...KEYS, "https://x.com/%\\\\"]) expect(opfsDirName(k)).toBe(await oracle.ask("opfsdir", [k]));
        expect(opfsDirName("https://one.com")).toBe("crn\u001fhttps:%2F%2Fone.com\u001f");
    });

    it("a Web Locks name goes to the native as the spec says (one starting with \"-\" as given)", async () => {
        const lock = fc.string({ maxLength: 8, unit: fc.constantFrom("a", "-", "\u001f", "é", " ") });
        await fc.assert(fc.asyncProperty(fc.constantFrom(...KEYS), lock, async (k, n) => {
            const spec = await oracle.ask("lockname", [k, n]);
            expect(lockName(namePrefix(k), n)).toBe(spec === "-native-" ? n : spec);
            if (spec === "-native-") expect(n.startsWith("-")).toBe(true);
        }), { numRuns: 300 });
    });

    it("a stored name is read under a key exactly as the spec reads it — never another key's", async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom(...KEYS), fc.constantFrom(...KEYS), name, async (k, k2, n) => {
            const s = storedName(k2, n);
            const spec = await oracle.ask("storeshown", [k, s]);
            const got = shownName(k, s);
            expect(got === null ? "nothing" : "just " + got).toBe(spec);
            if (k !== k2) expect(got).toBeNull(); // isolation
        }), { numRuns: 400 });
        expect(namePrefix("https://one.com")).toBe("crn\u001fhttps://one.com\u001f");
    });

    it("a write fits its partition's quota exactly as the spec decides (small quotas; the quota itself: Chromium's)", async () => {
        await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 40 }), fc.array(fc.tuple(fc.constantFrom("a", "b", "c"), fc.string({ maxLength: 12 })), { maxLength: 4 }), fc.constantFrom("a", "b", "z"), fc.string({ maxLength: 20 }), async (q, es, k, v) => {
            const entries = new Map<string, string>(es);
            const args = [String(q), k, v]; for (const [ek, ev] of entries) args.push(ek, ev);
            const spec = await oracle.ask("lsfits", args);
            expect(fitsQuota(entries, k, v, q) ? "yes" : "no").toBe(spec);
        }), { numRuns: 400 });
        expect(QUOTA).toBe(5242880);
    });
});

// The Partition keeps a running size: its setItem throws exactly when fitsQuota says no.
describe("localStorage partition: the running size is fitsQuota's", () => {
    const fake = (): { real: Storage; nat: NativeStorage } => {
        const m = new Map<string, string>();
        const real = {} as Storage;
        const nat: NativeStorage = {
            getItem(k) { return m.has(k) ? m.get(k)! : null; },
            setItem(k, v) { m.set(k, v); },
            removeItem(k) { m.delete(k); },
            key(i) { return [...m.keys()][i] ?? null; },
            length() { return m.size; },
        };
        return { real, nat };
    };
    it("over random writes and removals", () => {
        fc.assert(fc.property(fc.array(fc.tuple(fc.constantFrom("set", "remove"), fc.constantFrom("a", "b", "c"), fc.integer({ min: 0, max: QUOTA / 2 + 100 })), { maxLength: 12 }), (ops) => {
            const { real, nat } = fake();
            const p = new Partition("P", real, nat, null, (k) => Object.assign(new Error("quota " + k), { name: "QuotaExceededError" }));
            for (const [op, k, n] of ops) {
                if (op === "remove") { p.remove(k); continue; }
                const v = "v".repeat(n);
                const want = fitsQuota(p.mem, k, v);
                let ok = true;
                try { p.set(k, v); } catch { ok = false; }
                expect(ok).toBe(want);
            }
        }), { numRuns: 200 });
    });
});

// The native store is only a cache of a partition: a refusal of its own
// (a frame's Storage gone, "Access is denied for this document": seen on
// cornerstoneondemand.com's chat frame and sports-reference.com) never
// reaches the page; the page's refusals are its quota's alone.
describe("localStorage partition: the native cache's refusals are not the page's", () => {
    it("writes and removals within the quota succeed when the native store refuses everything", () => {
        const refuse = (): never => { throw Object.assign(new Error("Failed to execute 'removeItem' on 'Storage': Access is denied for this document."), { name: "SecurityError" }); };
        const nat: NativeStorage = { getItem: () => null, setItem: refuse, removeItem: refuse, key: () => null, length: () => 0 };
        const p = new Partition("P", {} as Storage, nat, null, (k) => Object.assign(new Error("quota " + k), { name: "QuotaExceededError" }));
        expect(() => p.set("a", "1")).not.toThrow();
        expect(p.get("a")).toBe("1");
        expect(() => p.remove("a")).not.toThrow();
        expect(() => p.remove("never")).not.toThrow();
        expect(p.get("a")).toBeNull();
        expect(() => p.set("b", "x".repeat(QUOTA))).toThrow(/quota b/);
    });
});
