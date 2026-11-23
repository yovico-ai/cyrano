// The page tree's cookies, in memory: what document.cookie and cookieStore
// read and write (spec/CookieJar.agda Mem; the server keeps the jar).
//
// Given with each document (the snapshot in its config), kept current by
// the channel through the browser's own jar on the proxy origin:
//   * inbox entries — changes the server made to the page's own site (a
//     response's Set-Cookie, an eviction) — absorbed before every read and
//     write, and when the browser's cookie store says it changed;
//   * a script's write goes to memory and to this tree's outbox slots
//     (a few cookies however many it writes), which ride the next request;
//     the server's ack (the highest number it read) clears them.
// Other tabs of the session hear of a write on a BroadcastChannel.
// Cookies of the old wire form (__crn!…) still in the browser's jar are
// read where memory holds nothing of their identity.

import { SafeWeakMap, ncall, sStarts } from "../native/intrinsics";
import { sharedData } from "../native/shared";
import { ACK, absorb, ack, chanName, chanValue, live, packSlot, sameId, snapshot, unchan, write, INBOX, OUTBOX, type Change, type Known } from "./jar";
import { jarCookies, wireName, type StoredCookie } from "./rfc";

interface Memory {
    known: Known[];
    seq: number;
    channel: BroadcastChannel | null;
    /** This tree's name as a writer (its slots, its ack). */
    tab: string;
    /** Writes the server has not acknowledged: [record name, value, number], one per identity. */
    pending: [string, string, number][];
    /** How many slots are in the browser's jar. */
    slots: number;
}

/** A slot's size, short of a cookie's 4096 (name and value). */
const SLOT = 3800;

/** A BroadcastChannel name no page uses (U+241F, as the other stores). */
const CHANNEL = "crn␟cookies";

const OUTBOX_LIFE = 86400;

function memory(win: Window): Memory {
    return sharedData<Memory>("cookieMemory", () => {
        const m: Memory = { known: [], seq: Math.floor(Math.random() * 1000), channel: null,
            tab: Math.floor(Math.random() * 0x7fffffff).toString(36) + Date.now().toString(36), pending: [], slots: 0 };
        const BC = (win as unknown as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
        try {
            if (BC) {
                const ch = new BC(CHANNEL);
                ch.onmessage = (e: MessageEvent): void => {
                    const d = e.data as { n?: unknown; v?: unknown } | null;
                    if (!d || typeof d.n !== "string" || typeof d.v !== "string") return;
                    const o = unchan(false, d.n, d.v);
                    if (o) write(m.known, o.change, o.n);
                };
                m.channel = ch;
            }
        } catch { /* no channel: other tabs learn through the inbox */ }
        return m;
    });
}

const now = (): number => Date.now();

/** Pairs of the browser's jar, as document.cookie lists it. */
function pairs(jar: string): [string, string][] {
    const out: [string, string][] = [];
    for (const p of jar.split(";")) {
        const t = p.replace(/^[ \t]+/, "");
        const i = t.indexOf("=");
        out.push(i < 0 ? ["", t] : [t.slice(0, i), t.slice(i + 1)]);
    }
    return out;
}

export interface CookieAccess {
    /** The native document.cookie getter, on this document. */
    get(): string;
    /** The native setter. */
    set(v: string): void;
}

// The snapshot each document came with, until its first cookie access
// (the document's URL is known by then: set_location follows install).
const pendingSnapshots = new SafeWeakMap<object, { g: number; e: string[] }>();

/** The snapshot the document of `win` came with (its config's `ck`); the tree's memory made now (its channel hears other tabs from the start). */
export function givenSnapshot(win: Window, ck: { g: number; e: string[] } | undefined): void {
    memory(win);
    if (ck) pendingSnapshots.set(win, ck);
}

/** This tree's outbox slots, rewritten from its pending writes. */
function writeSlots(m: Memory, access: CookieAccess): void {
    const slots: string[] = [];
    let cur: [string, string][] = [];
    let size = 0;
    for (let i = 0; i < m.pending.length; i++) {
        const [n, v] = m.pending[i]!;
        const add = n.length + v.length + 8;
        if (cur.length > 0 && size + add > SLOT) { slots.push(packSlot(cur)); cur = []; size = 0; }
        cur.push([n, v]);
        size += add;
    }
    if (cur.length > 0) slots.push(packSlot(cur));
    for (let i = 0; i < slots.length; i++) access.set(`${OUTBOX}${m.tab}!${i}=${slots[i]}; Path=/; Max-Age=${OUTBOX_LIFE}; Priority=Low`);
    for (let i = slots.length; i < m.slots; i++) access.set(`${OUTBOX}${m.tab}!${i}=; Path=/; Max-Age=0`);
    m.slots = slots.length;
}

/** The document's snapshot, taken into memory once, for its URL. */
export function snapshotFirst(win: Window, url: URL): void {
    const ck = pendingSnapshots.get(win);
    if (ck === undefined) return;
    pendingSnapshots.delete(win);
    takeSnapshot(win, url, ck);
}

/** The snapshot a document came with, taken into memory. */
export function takeSnapshot(win: Window, url: URL, ck: { g: number; e: string[] } | undefined): void {
    if (!ck || typeof ck.g !== "number" || !Array.isArray(ck.e)) return;
    const entries: { change: Change; n: number; applied: number }[] = [];
    for (let i = 0; i + 1 < ck.e.length; i += 2) {
        const o = unchan(true, String(ck.e[i]), String(ck.e[i + 1]));
        if (o && o.applied !== null) entries.push({ change: o.change, n: o.n, applied: o.applied });
    }
    snapshot(memory(win).known, url, ck.g, entries);
}

/**
 * The inbox entries in the browser's jar, absorbed; an outbox entry the
 * server has applied, and that no later write replaced, cleared. Gives the
 * old-form cookies the jar still holds.
 */
export function absorbInbox(win: Window, access: CookieAccess): StoredCookie[] {
    const m = memory(win);
    const jar = access.get();
    const legacy = jarCookies(jar);
    for (const [n, v] of pairs(jar)) {
        if (sStarts(n, INBOX)) {
            const o = unchan(true, n, v);
            if (o && o.applied !== null) absorb(m.known, o.change, o.n, o.applied);
        } else if (n === ACK + m.tab && /^[0-9]+![0-9]+$/.test(v)) {
            // The server read this tree's writes up to the ack: they are in,
            // as of the jar's generation then.
            const bang = v.indexOf("!");
            const a = Number(v.slice(0, bang));
            ack(m.known, a, Number(v.slice(bang + 1)));
            const before = m.pending.length;
            m.pending = m.pending.filter((p) => p[2] > a);
            if (m.pending.length !== before) writeSlots(m, access);
        }
    }
    return legacy;
}

/** The live cookies: memory's, and old-form ones it lacks (unordered, unselected). */
export function liveCookies(win: Window, legacy: StoredCookie[]): StoredCookie[] {
    const known = memory(win).known;
    const out = live(known, now());
    for (const c of legacy) if (!known.some((k) => sameId(k.change.cookie, c))) out.push(c);
    return out;
}

/** A script's write: to memory, to the outbox, to the other tabs. */
export function writeCookie(win: Window, access: CookieAccess, ch: Change, legacy: StoredCookie[]): void {
    const m = memory(win);
    const id = Date.now() * 1000 + (m.seq++ % 1000);
    write(m.known, ch, id);
    const name = chanName(false, ch), value = chanValue(ch, id, null);
    m.pending = m.pending.filter((p) => p[0] !== name);
    m.pending.push([name, value, id]);
    writeSlots(m, access);
    // An old-form cookie of the identity leaves the browser's jar.
    for (const c of legacy) if (sameId(c, ch.cookie)) access.set(`${wireName(c)}=; Path=/; Max-Age=0`);
    try { if (m.channel) ncall(m.channel.postMessage as (d: unknown) => void, m.channel, { n: name, v: value }); } catch { /* closed */ }
}

/** Every known cookie (live or not): what cookieStore lists from. */
export function knownCookies(win: Window): readonly Known[] { return memory(win).known; }

