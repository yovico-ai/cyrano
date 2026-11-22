// localStorage per original origin, each with its own quota
// (spec/LocalStore.agda).
//
// Every proxied site shares the proxy origin's one localStorage, so all of
// them shared one quota (5 242 880 UTF-16 code units, keys + values):
// sports-reference.com's caches threw QuotaExceededError through the proxy
// and not directly. A partition (storage key: patches/storage.ts) now has
//   * `mem` — its entries in memory, what page code reads and writes;
//   * IndexedDB — every entry of every partition (the disk's quota), on the
//     proxy origin under a name no page lists ("crn␟ls");
//   * the native localStorage — the entries that also fit there, read
//     synchronously when a page loads, before IndexedDB answers.
// A write goes to all three. When the native store is full, other
// partitions' entries leave it (least recently used partition first, and
// only one whose entries IndexedDB is known to hold); the write itself
// fails only when the writer's own partition passes the quota, as natively.
// When a partition loads again its entries evicted from the native store
// come back from IndexedDB (and are put back there when they fit): until
// then — the first moments of that load — they read as missing.
//
// Known gaps: an entry only IndexedDB holds is not seen by another tab
// until it reloads (the native `storage` event carries the others); a
// write lost to a tab closed before IndexedDB commits is lost only when
// the native store could not take it either.

import { SafeMap, nO, ncall, sStarts } from "../native/intrinsics";
import { sharedData } from "../native/shared";

/** Chromium's per-storage-key quota, in UTF-16 code units of keys and values (measured). */
export const QUOTA = 5242880;
const SEP = "\u001f";
const META = "crn" + SEP + "meta";
const DB = "crn" + SEP + "ls";

type AnyFn = (...a: never[]) => unknown;

export interface NativeStorage {
    getItem(this: Storage, k: string): string | null;
    setItem(this: Storage, k: string, v: string): void;
    removeItem(this: Storage, k: string): void;
    key(this: Storage, i: number): string | null;
    length: (this: Storage) => number;
}

/** The IndexedDB methods the store calls, taken before any page code (or our own name patch) runs. */
export interface NativeIdb {
    factory: IDBFactory;
    open: (this: IDBFactory, name: string, version?: number) => IDBOpenDBRequest;
}

export function captureIdb(g: Record<string, unknown>): NativeIdb | null {
    try {
        const factory = g["indexedDB"] as IDBFactory | undefined;
        const F = (g["IDBFactory"] as { prototype: IDBFactory } | undefined)?.prototype;
        if (!factory || !F) return null;
        return { factory, open: F.open as NativeIdb["open"] };
    } catch {
        return null; // a sandboxed (opaque) document: no IndexedDB
    }
}

interface Meta { [partition: string]: { t: number; s?: 1 } }

/** One partition's view of localStorage. */
export class Partition {
    readonly mem = new SafeMap<string, string>();
    size = 0;
    loaded = false;

    constructor(
        readonly prefix: string,
        private readonly real: Storage,
        private readonly nat: NativeStorage,
        private readonly idb: NativeIdb | null,
        private readonly quotaError: (key: string) => Error,
    ) {
        // Synchronously: what the native store holds of it.
        const n = ncall(nat.length, real);
        for (let i = 0; i < n; i++) {
            const k = ncall(nat.key, real, i);
            if (k === null || !sStarts(k, prefix)) continue;
            const v = ncall(nat.getItem, real, k);
            if (v === null) continue;
            const name = k.slice(prefix.length);
            this.mem.set(name, v);
            this.size += name.length + v.length;
        }
        this.touch(false);
        void this.load();
    }

    get(k: string): string | null { const v = this.mem.get(k); return v === undefined ? null : v; }
    keys(): string[] { return [...this.mem.keys()]; }

    set(k: string, v: string): void {
        const old = this.mem.get(k);
        const next = this.size - (old === undefined ? 0 : k.length + old.length) + k.length + v.length;
        if (next > QUOTA) throw this.quotaError(k);
        this.mem.set(k, v);
        this.size = next;
        this.put(k, v);
        this.nativeSet(k, v);
    }

    remove(k: string): void {
        const old = this.mem.get(k);
        if (old === undefined) { ncall(this.nat.removeItem, this.real, this.prefix + k); return; }
        this.mem.delete(k);
        this.size -= k.length + old.length;
        this.del(k);
        ncall(this.nat.removeItem, this.real, this.prefix + k);
    }

    clear(): void { for (const k of this.keys()) this.remove(k); }

    /** Another tab wrote the native store (its `storage` event). */
    external(k: string, v: string | null): void {
        const old = this.mem.get(k);
        if (old !== undefined) this.size -= k.length + old.length;
        if (v === null) this.mem.delete(k);
        else { this.mem.set(k, v); this.size += k.length + v.length; }
    }

    // ── the native store: a cache, other partitions evicted to make room ──

    private nativeSet(k: string, v: string): boolean {
        for (let attempt = 0; attempt < 64; attempt++) {
            try {
                ncall(this.nat.setItem, this.real, this.prefix + k, v);
                return true;
            } catch {
                if (!this.evictOne()) break;
            }
        }
        // It does not fit: it lives in IndexedDB only. An older copy must
        // not be read at the next load in its place.
        ncall(this.nat.removeItem, this.real, this.prefix + k);
        return false;
    }

    /** Removes from the native store the least recently used other partition IndexedDB holds. */
    private evictOne(): boolean {
        const meta = this.meta();
        let victim: string | null = null, oldest = Infinity;
        for (const p of nO.keys(meta)) {
            const m = meta[p]!;
            if (p !== this.prefix && m.s === 1 && m.t < oldest) { oldest = m.t; victim = p; }
        }
        if (victim === null) return false;
        const n = ncall(this.nat.length, this.real);
        const drop: string[] = [];
        for (let i = 0; i < n; i++) {
            const k = ncall(this.nat.key, this.real, i);
            if (k !== null && sStarts(k, victim)) drop.push(k);
        }
        for (const k of drop) ncall(this.nat.removeItem, this.real, k);
        delete meta[victim];
        this.writeMeta(meta);
        return true;
    }

    private meta(): Meta {
        try { const raw = ncall(this.nat.getItem, this.real, META); return raw ? (JSON.parse(raw) as Meta) : {}; } catch { return {}; }
    }
    private writeMeta(m: Meta): void {
        try { ncall(this.nat.setItem, this.real, META, JSON.stringify(m)); } catch { /* full: the next write retries */ }
    }
    /** Marks this partition used now (and, once IndexedDB holds all of it, safe to evict). */
    private touch(synced: boolean): void {
        const m = this.meta();
        const prev = m[this.prefix];
        m[this.prefix] = synced || prev?.s === 1 ? { t: Date.now(), s: 1 } : { t: Date.now() };
        this.writeMeta(m);
    }

    // ── IndexedDB: every entry ──

    private db: Promise<IDBDatabase | null> | null = null;
    private open(): Promise<IDBDatabase | null> {
        if (this.db) return this.db;
        const idb = this.idb;
        this.db = new Promise((resolve) => {
            if (!idb) { resolve(null); return; }
            let req: IDBOpenDBRequest;
            try { req = ncall(idb.open as AnyFn, idb.factory, DB, 1) as IDBOpenDBRequest; } catch { resolve(null); return; }
            req.onupgradeneeded = () => {
                const s = req.result.createObjectStore("e", { keyPath: ["p", "k"] });
                s.createIndex("p", "p");
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        });
        return this.db;
    }
    private tx(mode: IDBTransactionMode, run: (s: IDBObjectStore) => void): Promise<void> {
        return this.open().then((db) => new Promise<void>((resolve) => {
            if (!db) { resolve(); return; }
            try {
                const t = db.transaction("e", mode);
                run(t.objectStore("e"));
                t.oncomplete = () => resolve();
                t.onerror = () => resolve();
                t.onabort = () => resolve();
            } catch { resolve(); }
        }));
    }
    private put(k: string, v: string): void { void this.tx("readwrite", (s) => { s.put({ p: this.prefix, k, v }); }); }
    private del(k: string): void { void this.tx("readwrite", (s) => { s.delete([this.prefix, k]); }); }

    /** Brings back what only IndexedDB holds, and gives IndexedDB what only the native store does. */
    private async load(): Promise<void> {
        const db = await this.open();
        if (!db) { this.loaded = true; return; }
        const stored = await new Promise<Array<{ k: string; v: string }>>((resolve) => {
            try {
                const r = db.transaction("e", "readonly").objectStore("e").index("p").getAll(this.prefix);
                r.onsuccess = () => resolve(r.result as Array<{ k: string; v: string }>);
                r.onerror = () => resolve([]);
            } catch { resolve([]); }
        });
        const inDb = new SafeMap<string, string>();
        for (const e of stored) inDb.set(e.k, e.v);
        // Written since the page loaded, or by the native store only: IndexedDB gets it.
        const missing: Array<[string, string]> = [];
        for (const [k, v] of this.mem) if (inDb.get(k) !== v) missing.push([k, v]);
        // Only IndexedDB has it: it comes back, and into the native store if it fits.
        for (const [k, v] of inDb) {
            if (this.mem.has(k)) continue;
            this.mem.set(k, v);
            this.size += k.length + v.length;
            try { ncall(this.nat.setItem, this.real, this.prefix + k, v); } catch { /* stays cold */ }
        }
        await this.tx("readwrite", (s) => { for (const [k, v] of missing) s.put({ p: this.prefix, k, v }); });
        this.loaded = true;
        this.touch(true);
    }
}

/** The partitions of a page tree (one per storage key), shared by its runtimes. */
const partitions = sharedData("ls.partitions", () => new SafeMap<string, Partition>());

export function partitionFor(prefix: string, real: Storage, nat: NativeStorage, idb: NativeIdb | null, quotaError: (k: string) => Error): Partition {
    let p = partitions.get(prefix);
    if (!p) { p = new Partition(prefix, real, nat, idb, quotaError); partitions.set(prefix, p); }
    return p;
}
