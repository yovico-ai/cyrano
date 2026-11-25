// @vitest-environment node
//
// Conformance of src/cookies/jar.ts with spec/CookieJar.agda, asked live:
// the channel's form both ways (`chan`, `unchan`), and random scripts of a
// runtime's memory — inbox entries absorbed, its own writes, snapshots,
// reads (`mem`).

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { absorb, ack, memEvict, chanName, chanValue, memCookies, packSlot, snapshot, unchan, unpackSlot, write, type Change, type Known } from "../../src/cookies/jar";
import { parseSetCookie, scope, storeCookie } from "../../src/cookies/rfc";
import { OracleClient, locateOracle, oracleRequired } from "./oracle-client";

const located = locateOracle();
if (located.skip !== "" && oracleRequired) throw new Error(located.skip);

const US = "\u001f";
const URLS = ["https://a.example/", "https://www.a.example/app/x", "http://a.example/", "https://b.example/p"];
const NAMES = ["sid", "a", "__Host-h", "x"];
const ATTRS = ["", "; Secure", "; Priority=Low", "; Priority=High", "; Domain=a.example", "; Path=/app", "; SameSite=Lax", "; SameSite=None; Secure"];
const KEYS = ["-", "-", "https://a.example", "https://a.example^"];
const CTXS: (null | { top: string; cross: boolean })[] = [null, { top: "https://a.example", cross: false }, { top: "https://a.example", cross: true }, { top: "https://b.example", cross: false }];

const change = (u: string, s: string, e: string, pk = "-"): Change | null => {
    const sc = parseSetCookie(s);
    const c0 = sc && storeCookie(false, false, new URL(u), sc);
    if (!c0) return null;
    const c = pk === "-" ? c0 : { ...c0, partitionKey: pk };
    return e === "x" ? { cookie: c, gone: true, expiry: { session: true } }
        : e === "" ? { cookie: c, gone: false, expiry: { session: true } } : { cookie: c, gone: false, expiry: { session: false, until: Number(e) } };
};

const arbChange = fc.tuple(fc.constantFrom(...URLS), fc.constantFrom(...NAMES), fc.constantFrom("1", "", "a:b!c", "é"), fc.constantFrom(...ATTRS),
    fc.constantFrom("", "x", "1795000100000", "1795000900000", "1795000100000.749", "1795000900000.5"), fc.constantFrom(...KEYS));

describe.skipIf(located.skip !== "")("the cookie jar's runtime half: the spec", () => {
    let oracle: OracleClient;
    beforeAll(() => { oracle = new OracleClient(located.path); });
    afterAll(() => oracle?.close());

    it("writes and reads the channel's form as the spec", async () => {
        await fc.assert(fc.asyncProperty(fc.boolean(), arbChange, fc.nat(99), fc.nat(9), async (inbox, [u, n, v, a, e, pk], k, ap) => {
            const s = `${n}=${v}${a}`;
            const want = await oracle.ask("chan", [inbox ? "in" : "out", u, s, e, String(k), inbox ? String(ap) : "-", ...(pk === "-" ? [] : [pk])]);
            const ch = change(u, s, e, pk);
            if (!ch) { expect(want).toBeNull(); return; }
            const name = chanName(inbox, ch), value = chanValue(ch, k, inbox ? ap : null);
            expect(`${name}\n${value}`, s).toBe(want);
            const back = unchan(inbox, name, value);
            const wantBack = await oracle.ask("unchan", [inbox ? "in" : "out", name, value]);
            const c = back!.change.cookie;
            expect(c.partitionKey ?? "-", name).toBe(pk);
            const dump = [c.hostOnly ? "h" : "d", c.domain, c.path, c.name, back!.change.gone ? "" : c.value, c.secure ? "s" : "i", c.sameSite, c.priority,
                back!.change.gone ? "x" : back!.change.expiry.session ? "" : String(back!.change.expiry.until), String(back!.n), back!.applied === null ? "-" : String(back!.applied)].join("\n");
            expect(dump, `${name} ${value}`).toBe(wantBack);
        }), { numRuns: 600 });
    });

    it("packs the outbox's slots as the spec", async () => {
        const piece = fc.constantFrom("a", "%", "~", "*", "%25", "%7e", "!", ":", "é", "", "__crn~o!h!x!%2F!n");
        await fc.assert(fc.asyncProperty(fc.array(fc.tuple(fc.array(piece, { minLength: 1, maxLength: 4 }), fc.array(piece, { maxLength: 4 })), { minLength: 1, maxLength: 4 }),
            async (rs) => {
                const recs = rs.map(([a, b]) => [a.join(""), b.join("")] as [string, string]);
                const packed = packSlot(recs);
                expect(packed).toBe(await oracle.ask("pack", [recs.flat().join(US)]));
                expect(unpackSlot(packed).map(([n, v]) => n + US + v).join("\n")).toBe(await oracle.ask("unpack", [packed]));
                expect(unpackSlot(packed)).toEqual(recs);
            }), { numRuns: 400 });
    });

    it("keeps memory as the spec", async () => {
        const op = fc.oneof(
            fc.tuple(fc.constant("absorb"), arbChange, fc.nat(8), fc.nat(5)),
            fc.tuple(fc.constant("write"), arbChange, fc.nat(8), fc.constant(0)),
            fc.tuple(fc.constant("snap"), fc.array(arbChange, { maxLength: 3 }), fc.nat(8), fc.constantFrom(...URLS), fc.constantFrom(...CTXS)),
            fc.tuple(fc.constant("read"), fc.constantFrom(1795000000000, 1795000500000, 1795001000000), fc.constantFrom(...URLS), fc.constant(0), fc.constantFrom(...CTXS)),
            fc.tuple(fc.constant("ack"), fc.nat(8), fc.nat(8), fc.constant(0)),
        );
        await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 14 }), async (ops) => {
            const lines: string[] = [];
            const mem: Known[] = [];
            const reads: string[] = [];
            for (const o of ops) {
                if (o[0] === "absorb" || o[0] === "write") {
                    const [, [u, n, v, a, e, pk], k, ap] = o as [string, [string, string, string, string, string, string], number, number];
                    const ch = change(u, `${n}=${v}${a}`, e, pk);
                    if (!ch) continue;
                    const inbox = o[0] === "absorb";
                    lines.push([o[0], chanName(inbox, ch), chanValue(ch, k, inbox ? ap : null)].join(US));
                    if (inbox) absorb(mem, ch, k, ap); else write(mem, ch, k);
                } else if (o[0] === "snap") {
                    const [, cs, g, u, cx] = o as [string, [string, string, string, string, string, string][], number, string, { top: string; cross: boolean } | null];
                    const entries: { change: Change; n: number; applied: number }[] = [];
                    const fields: string[] = [];
                    for (const [cu, n, v, a, e, pk] of cs) {
                        const ch = change(cu, `${n}=${v}${a}`, e, pk);
                        if (!ch) continue;
                        entries.push({ change: ch, n: g, applied: 0 });
                        fields.push(chanName(true, ch), chanValue(ch, g, 0));
                    }
                    lines.push((cx === null ? ["snap", u, String(g), ...fields] : ["snapx", cx.top, cx.cross ? "cross" : "same", u, String(g), ...fields]).join(US));
                    snapshot(mem, new URL(u), g, entries, cx);
                } else if (o[0] === "ack") {
                    const a = o[1] as number, g = o[2] as number;
                    lines.push(["ack", String(a), String(g)].join(US));
                    ack(mem, a, g);
                } else {
                    const [, now, u, , cx] = o as unknown as [string, number, string, number, { top: string; cross: boolean } | null];
                    lines.push((cx === null ? ["read", String(now), u] : ["readx", cx.top, cx.cross ? "cross" : "same", String(now), u]).join(US));
                    reads.push("R" + US + memCookies(mem, now, new URL(u), cx));
                }
            }
            const want = await oracle.ask("mem", [lines.join("\n")]);
            const known = mem.map((k) => ["K", scope(k.change.cookie), (k.change.cookie.secure ? "s" : "i") + k.change.cookie.sameSite + k.change.cookie.priority,
                k.change.gone ? "x" : k.change.expiry.session ? "" : String(k.change.expiry.until), String(k.gen), k.pending === null ? "-" : String(k.pending),
                k.change.gone ? "" : k.change.cookie.value].join(US));
            expect([...reads, ...known].join("\n"), lines.join("\n").replace(/\u001f/g, " | ")).toBe(want);
        }), { numRuns: 600 });
    });

    // Chromium's site limit in memory, at once (spec memEvict; the site: the cookie's domain here).
    it("a site's limit in memory as the spec", async () => {
        await fc.assert(fc.asyncProperty(fc.array(fc.tuple(fc.constantFrom("", "; Secure", "; Priority=Low", "; Priority=High", "; Secure; Priority=High"), fc.nat(3)), { minLength: 181, maxLength: 230 }),
            async (attrs) => {
                const lines: string[] = [];
                const mem: Known[] = [];
                const now = 1795000000000;
                attrs.forEach(([a, vv], i) => {
                    const ch = change("https://a.example/", `k${i % 205}=${vv}${a}`, "1795000900000");
                    if (!ch) return;
                    lines.push(["writel", chanName(false, ch), chanValue(ch, i, null), String(now)].join(US));
                    write(mem, ch, i);
                    memEvict(mem, (c) => c.domain, now, ch.cookie.domain);
                });
                const want = await oracle.ask("mem", [lines.join("\n")]);
                const known = mem.map((k) => ["K", scope(k.change.cookie), (k.change.cookie.secure ? "s" : "i") + k.change.cookie.sameSite + k.change.cookie.priority,
                    k.change.gone ? "x" : k.change.expiry.session ? "" : String(k.change.expiry.until), String(k.gen), k.pending === null ? "-" : String(k.pending),
                    k.change.gone ? "" : k.change.cookie.value].join(US));
                expect(known.join("\n")).toBe(want);
            }), { numRuns: 30 });
    });
});
