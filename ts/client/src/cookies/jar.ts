// The runtime's half of the server-side cookie jar: a port of the memory
// and channel of spec/CookieJar.agda (Go: internal/cookiejar, the jar
// itself). Checked against the spec by tests/spec/cookie-jar-conformance.
//
// The server keeps every cookie of the session. A page's runtime keeps the
// script-visible ones in memory — given with the document (the snapshot)
// and kept current through short-lived cookies of the browser's own jar:
// the inbox (a change the server made, numbered by its generation, naming
// the last outbox applied) and the outbox (a script's write, numbered by
// its writer, applied by the server once).

import { cookieDate } from "./date";
import { cookieString, inCtx, matches, parseScope, scope, type CookieCtx, type Priority, type SameSite, type SetCookie, type StoredCookie } from "./rfc";
import { sStarts } from "../native/intrinsics";

export type Expiry = { session: true } | { session: false; until: number };
export interface Change { cookie: StoredCookie; gone: boolean; expiry: Expiry }
export interface Known { change: Change; gen: number; pending: number | null }

export const INBOX = "__crn~i!";
export const OUTBOX = "__crn~o!";
const CAP = 400 * 86400 * 1000;

export const sameId = (a: StoredCookie, b: StoredCookie): boolean =>
    a.name === b.name && a.domain === b.domain && a.path === b.path && a.hostOnly === b.hostOnly && a.partitionKey === b.partitionKey;

export const alive = (now: number, e: Expiry): boolean => e.session || now < e.until;

const natOf = (s: string): number | null => (/^[0-9]+$/.test(s) ? Number(s) : null);

/** A Set-Cookie's expiry at `now` (ms), or null: already expired (spec expiryOf). */
export function expiryOf(now: number, sc: SetCookie): Expiry | null {
    const capped = (t: number): number => Math.min(t, now + CAP);
    const byExpires = (): Expiry | null => {
        if (sc.expires === null) return { session: true };
        const t = cookieDate(sc.expires);
        if (t === null) return { session: true };
        return t * 1000 <= now ? null : { session: false, until: capped(t * 1000) };
    };
    const m = sc.maxAge;
    if (m === null || m === "") return byExpires();
    if (m[0] === "-") return null;
    const n = natOf(m);
    if (n === null) return byExpires();
    if (n === 0) return null;
    return { session: false, until: capped(now + Math.min(n, 400 * 86400) * 1000) };
}

const flags = (c: StoredCookie): string => (c.secure ? "s" : "i") + c.sameSite + c.priority;
/** A time in ms (to the µs) as the channel writes it (spec CookieJar.msText): ms, and its microseconds as a fraction. */
export function msText(ms: number): string {
    const us = Math.round(ms * 1000);
    const f = us % 1000;
    return String((us - f) / 1000) + (f === 0 ? "" : "." + String(f).padStart(3, "0").replace(/0+$/, ""));
}
/** msText read back (spec CookieJar.msNum), in ms; null when not that form. */
export function msNum(s: string): number | null {
    const m = /^([0-9]+)(?:\.([0-9]{1,3}))?$/.exec(s);
    if (!m) return null;
    return (Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0") || "0")) / 1000;
}
const expiryText = (ch: Change): string => (ch.gone ? "x" : ch.expiry.session ? "" : msText(ch.expiry.until));

export const chanName = (inbox: boolean, ch: Change): string => (inbox ? INBOX : OUTBOX) + scope(ch.cookie);

export function chanValue(ch: Change, n: number, applied: number | null): string {
    return `${flags(ch.cookie)}!${expiryText(ch)}!${n}${applied === null ? "" : "!" + applied}:${ch.gone ? "" : ch.cookie.value}`;
}

/** A channel entry read back (spec unchan), or null. */
export function unchan(inbox: boolean, name: string, value: string): { change: Change; n: number; applied: number | null } | null {
    const p = inbox ? INBOX : OUTBOX;
    if (!sStarts(name, p)) return null;
    const sc = parseScope(name.slice(p.length));
    if (!sc) return null;
    if (value.length < 4 || value[3] !== "!" || (value[0] !== "s" && value[0] !== "i") || "nltu".indexOf(value[1]!) < 0 || "LMH".indexOf(value[2]!) < 0) return null;
    const rest = value.slice(4);
    const b1 = rest.indexOf("!");
    if (b1 < 0) return null;
    const e = rest.slice(0, b1);
    const r2 = rest.slice(b1 + 1);
    const colon = r2.indexOf(":");
    if (colon < 0) return null;
    const nums = r2.slice(0, colon), val = r2.slice(colon + 1);
    const b2 = nums.indexOf("!");
    const n = natOf(b2 < 0 ? nums : nums.slice(0, b2));
    if (n === null) return null;
    let applied: number | null = null;
    if (b2 >= 0) {
        applied = natOf(nums.slice(b2 + 1));
        if (applied === null) return null;
    }
    if (inbox !== (applied !== null)) return null;
    const cookie: StoredCookie = { ...sc, value: val, secure: value[0] === "s", httpOnly: false, sameSite: value[1] as SameSite, priority: value[2] as Priority };
    let change: Change;
    if (e === "x") change = { cookie, gone: true, expiry: { session: true } };
    else if (e === "") change = { cookie, gone: false, expiry: { session: true } };
    else {
        const t = msNum(e);
        if (t === null) return null;
        change = { cookie, gone: false, expiry: { session: false, until: t } };
    }
    return { change, n, applied };
}

// Memory's order is the creation order: a change keeps a cookie's place
// when its value stays, else it is a new cookie, last (spec placed).
const sameValue = (a: Change, b: Change): boolean => !a.gone && !b.gone && a.cookie.value === b.cookie.value;
function place(mem: Known[], i: number, k: Known): void {
    if (sameValue(mem[i]!.change, k.change)) { mem[i] = k; return; }
    mem.splice(i, 1);
    mem.push(k);
}

/** An inbox (or snapshot) entry of generation g, the last outbox applied a (spec absorb). */
export function absorb(mem: Known[], ch: Change, g: number, a: number): void {
    for (let i = 0; i < mem.length; i++) {
        const k = mem[i]!;
        if (!sameId(k.change.cookie, ch.cookie)) continue;
        const takes = k.pending !== null ? k.pending <= a : k.gen < g;
        if (takes) place(mem, i, { change: ch, gen: g, pending: null });
        return;
    }
    mem.push({ change: ch, gen: g, pending: null });
}

/** A script's own write, numbered p (spec write). */
export function write(mem: Known[], ch: Change, p: number): void {
    for (let i = 0; i < mem.length; i++) {
        const k = mem[i]!;
        if (sameId(k.change.cookie, ch.cookie)) { place(mem, i, { change: ch, gen: k.gen, pending: p }); return; }
    }
    mem.push({ change: ch, gen: 0, pending: p });
}

/** The live cookies (spec liveOf). */
export function live(mem: readonly Known[], now: number): StoredCookie[] {
    const out: StoredCookie[] = [];
    for (const k of mem) if (!k.change.gone && alive(now, k.change.expiry)) out.push(k.change.cookie);
    return out;
}

/** document.cookie at `url` (spec memCookies). */
export function memCookies(mem: readonly Known[], now: number, url: URL, ctx: CookieCtx | null = null): string {
    const kept = live(mem, now).filter((c) => matches(true, url, c) && (ctx === null || inCtx(true, ctx, c)));
    const len = (c: StoredCookie): number => [...c.path].length;
    return cookieString(kept.map((c, i) => [c, i] as const).sort((a, b) => len(b[0]) - len(a[0]) || a[1] - b[1]).map(([c]) => c));
}

/** The snapshot a document comes with, of generation g, for its URL (spec snapshot). */
export function snapshot(mem: Known[], url: URL, g: number, entries: { change: Change; n: number; applied: number }[], ctx: CookieCtx | null = null): void {
    for (let i = 0; i < mem.length; i++) {
        const k = mem[i]!;
        if (k.pending !== null || k.change.gone) continue;
        const c = k.change.cookie;
        // (only what its context lists: the others the snapshot never held)
        if (matches(true, url, c) && (ctx === null || inCtx(true, ctx, c)) && k.gen <= g && !entries.some((e) => sameId(e.change.cookie, c))) {
            mem[i] = { change: { cookie: c, gone: true, expiry: { session: true } }, gen: g, pending: null };
        }
    }
    for (const e of entries) absorb(mem, e.change, e.n, e.applied);
}

// ── the outbox, packed (spec packSlot, unpackSlot, ack) ─────────────────

export const ACK = "__crn~a!";

const sepEsc = (s: string): string => s.replace(/[%~*]/g, (c) => (c === "%" ? "%25" : c === "~" ? "%7E" : "%2A"));
const sepUnesc = (s: string): string => s.replace(/%(25|7[Ee]|2[Aa])/g, (m) => (m === "%25" ? "%" : m[1] === "7" ? "~" : "*"));

/** Records (one-write outbox entries' names and values) as a slot's value. */
export const packSlot = (records: readonly (readonly [string, string])[]): string =>
    records.map(([n, v]) => sepEsc(n) + "*" + sepEsc(v)).join("~");

/** A slot's value read back. */
export function unpackSlot(v: string): [string, string][] {
    return v.split("~").map((r): [string, string] => {
        const i = r.indexOf("*");
        return i < 0 ? [sepUnesc(r), ""] : [sepUnesc(r.slice(0, i)), sepUnesc(r.slice(i + 1))];
    });
}

/** The server's ack: this runtime's writes numbered up to a are in, as of generation g (spec ack). */
export function ack(mem: Known[], a: number, g: number): void {
    for (let i = 0; i < mem.length; i++) {
        const k = mem[i]!;
        if (k.pending !== null && k.pending <= a) mem[i] = { ...k, pending: null, gen: Math.max(k.gen, g) };
    }
}
