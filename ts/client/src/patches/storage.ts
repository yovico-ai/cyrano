// Storage, per original origin.
//
// Every proxied site really lives on the proxy's origin, so the browser
// gives them all one localStorage, one sessionStorage, one set of IndexedDB
// databases, caches and broadcast channels: any site could read another's
// data, and a page finds hundreds of keys it never wrote. Directly, each
// origin has its own — and a frame embedded by another site gets a
// partition of its own, keyed by the top-level site as well.
//
// So every name is stored under a prefix that names the context's storage
// key as Chromium makes it (spec/Storage.agda partitionKey): the original
// origin for a first-party context — its site and every ancestor's the
// top-level site — else the origin with the top-level site (an A-B-A
// frame is third-party; a same-site frame is not). Page code sees only its
// own names, unprefixed:
//
//   - localStorage / sessionStorage: a view per window — methods, length,
//     named properties, enumeration — and `storage` events of other
//     origins never reach the page;
//   - indexedDB: database names (open, deleteDatabase, databases, name);
//   - caches: cache names (open, has, delete, keys, match's cacheName);
//   - BroadcastChannel: channel names.
//
// The IndexedDB, cache and channel parts also run in workers.
//
// Known gaps: SharedWorker names and Web Locks names are shared; data
// stored before this existed stays, invisible, under its bare names.

import { getDomain } from "tldts";

import { SafeWeakMap, nO, nR, ncall, sStarts, sIncludes } from "../native/intrinsics";
import { internalsOf } from "../native/internals";
import { wrapAccessor, wrapConstructor, wrapMethod } from "../native/surface";
import { captureIdb, partitionFor, type NativeStorage, type Partition } from "./local-store";

const SEP = "\u001f";
const TAG = "crn" + SEP;

/** The prefix of a storage key's names (spec/Storage.agda namePrefix): "crn␟KEY␟". */
export function namePrefix(key: string): string { return TAG + key + SEP; }
/** A name as stored under a key (spec stored). */
export function storedName(key: string, name: string): string { return namePrefix(key) + name; }
/** A stored name read back under a key, or null when it is not that key's (spec shown). */
export function shownName(key: string, stored: string): string | null {
    const p = namePrefix(key);
    return sStarts(stored, p) ? stored.slice(p.length) : null;
}

/** The prefix of this context's names: its storage key (partitionKey). */
export type Prefix = () => string;

/** A URL's schemeful site: scheme and registrable domain (the host where it has none). */
export function siteOf(u: URL): string {
    const host = u.hostname;
    return `${u.protocol}//${getDomain(host, { allowPrivateDomains: true }) ?? host}`;
}

/**
 * Chromium's storage key for a context (spec/Storage.agda partitionKey):
 * ancestors' sites from the top-level document down to the parent.
 */
export function partitionKey(ancestors: string[], site: string, origin: string): string {
    if (ancestors.length === 0) return origin;
    const top = ancestors[0]!;
    let third = site !== top;
    for (let i = 1; i < ancestors.length; i++) third = third || ancestors[i] !== top;
    return third ? `${origin}^${top}` : origin;
}

export function storagePrefix(targetWindow: Window, origin: () => string): Prefix {
    return () => {
        const own = origin();
        const ancestors: string[] = [];
        try {
            let w: Window = targetWindow;
            for (let i = 0; i < 64 && w.parent && w.parent !== w; i++) {
                w = w.parent;
                const base = internalsOf(w)?.api.get_base_url();
                if (!base) break; // a really cross-origin ancestor: no partition known past it
                ancestors.unshift(siteOf(base));
            }
        } catch { /* a really cross-origin ancestor */ }
        let site = own;
        try { site = siteOf(new URL(own)); } catch { /* an opaque origin */ }
        return namePrefix(partitionKey(ancestors, site, own));
    };
}

// ── names: IndexedDB, caches, BroadcastChannel (windows and workers) ────

export function patchStorageNames(scope: object, prefix: Prefix): void {
    const g = scope as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const mine = (name: unknown): string => prefix() + String(name);
    const shown = (name: string): string | null => {
        const p = prefix();
        return sStarts(name, p) ? name.slice(p.length) : null;
    };

    const F = g["IDBFactory"]?.prototype as object | undefined;
    if (F) {
        for (const key of ["open", "deleteDatabase"]) {
            wrapMethod<(...a: unknown[]) => unknown>(F, key, (native, self, args) =>
                nR.apply(native, self, args.length ? [mine(args[0]), ...args.slice(1)] : args));
        }
        if ("databases" in F) {
            wrapMethod<(...a: unknown[]) => Promise<Array<{ name?: string; version?: number }>>>(F, "databases", (native, self, args) =>
                (nR.apply(native, self, args) as Promise<Array<{ name?: string; version?: number }>>).then((list) =>
                    list.flatMap((d) => {
                        const n = typeof d.name === "string" ? shown(d.name) : null;
                        return n === null ? [] : [{ ...d, name: n }];
                    })));
        }
    }
    const DB = g["IDBDatabase"]?.prototype as object | undefined;
    if (DB && nO.getOwnPropertyDescriptor(DB, "name")) {
        wrapAccessor<string>(DB, "name", { get: (get, self) => { const n = ncall(get, self); return shown(n) ?? n; } });
    }

    const C = g["CacheStorage"]?.prototype as object | undefined;
    if (C) {
        for (const key of ["open", "has", "delete"]) {
            wrapMethod<(...a: unknown[]) => unknown>(C, key, (native, self, args) =>
                nR.apply(native, self, args.length ? [mine(args[0]), ...args.slice(1)] : args));
        }
        wrapMethod<(...a: unknown[]) => Promise<string[]>>(C, "keys", (native, self, args) =>
            (nR.apply(native, self, args) as Promise<string[]>).then((names) => names.flatMap((n) => shown(n) ?? [])));
        wrapMethod<(...a: unknown[]) => unknown>(C, "match", (native, self, args) => {
            const o = args[1] as { cacheName?: unknown } | undefined;
            if (o && typeof o === "object" && o.cacheName !== undefined) {
                return nR.apply(native, self, [args[0], { ...o, cacheName: mine(o.cacheName) }]);
            }
            // Without a cacheName the native searches every cache: only this origin's.
            const keys = (C as { keys: (this: unknown) => Promise<string[]> }).keys;
            const open = (C as { open: (this: unknown, n: string) => Promise<Cache> }).open;
            return ncall(keys, self).then(async (names) => {
                for (const n of names) {
                    const hit = await (await ncall(open, self, n)).match(args[0] as RequestInfo, o as CacheQueryOptions);
                    if (hit) return hit;
                }
                return undefined;
            });
        });
    }

    const BC = wrapConstructor<typeof BroadcastChannel>(scope, "BroadcastChannel", (Native, args, newTarget) =>
        nR.construct(Native, args.length ? [mine(args[0]), ...args.slice(1)] : args, newTarget as typeof BroadcastChannel));
    if (BC && nO.getOwnPropertyDescriptor(BC.prototype, "name")) {
        wrapAccessor<string>(BC.prototype, "name", { get: (get, self) => { const n = ncall(get, self); return shown(n) ?? n; } });
    }
}

// ── localStorage / sessionStorage ───────────────────────────────────────

export function patchWebStorage(targetWindow: Window, prefix: Prefix, unwrapOne: (url: string) => string): void {
    const g = targetWindow as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const SP = g["Storage"]?.prototype as Storage | undefined;
    if (!SP) return;
    const nat = {
        getItem: SP.getItem, setItem: SP.setItem, removeItem: SP.removeItem, key: SP.key,
        length: nO.getOwnPropertyDescriptor(SP, "length")?.get as ((this: Storage) => number) | undefined,
    };
    if (!nat.length) return;
    const nativeLength = nat.length;

    // localStorage: per partition, with its own quota (local-store.ts,
    // spec/LocalStore.agda). sessionStorage stays the native one, prefixed.
    const idb = captureIdb(g);
    let nativeLocal: Storage | null = null;
    try {
        const d = nO.getOwnPropertyDescriptor(targetWindow, "localStorage");
        nativeLocal = d?.get ? (ncall(d.get as (this: Window) => Storage, targetWindow) as Storage) : null;
    } catch { nativeLocal = null; } // a sandboxed document: the native throws
    const DOMExc = g["DOMException"] as (new (m: string, n: string) => Error) | undefined;
    const quotaError = (k: string): Error => DOMExc
        ? new DOMExc(`Failed to execute 'setItem' on 'Storage': Setting the value of '${k}' exceeded the quota.`, "QuotaExceededError")
        : new Error("QuotaExceededError");
    // A native refusal names what was stored ("crn␟KEY␟name"): the page
    // reads its own name, as directly (sports-reference.com's quota errors).
    const asPages = <T,>(stored: string, name: string, f: () => T): T => {
        try { return f(); } catch (e) {
            const m = (e as { message?: unknown })?.message;
            if (DOMExc && typeof m === "string" && sIncludes(m, stored)) {
                throw new DOMExc(m.split(stored).join(name), String((e as { name?: unknown }).name));
            }
            throw e;
        }
    };
    const tier = (real: Storage): Partition | null =>
        real === nativeLocal ? partitionFor(prefix(), real, nat as unknown as NativeStorage, idb, quotaError) : null;

    const views = new SafeWeakMap<object, Storage>(); // view → real
    const viewOf = new SafeWeakMap<Storage, object>(); // real → view
    /** The real Storage behind what page code holds (a view, or the object itself). */
    const realOf = (x: unknown): Storage | null => {
        if (typeof x !== "object" || x === null) return null;
        const r = views.get(x);
        if (r) return r;
        try { ncall(nativeLength, x as Storage); return x as Storage; } catch { return null; } // not a Storage: the native throws
    };

    // This origin's keys in a storage, unprefixed. Scanning is linear in
    // everything stored on the proxy origin, so the list is kept until
    // something may have changed it.
    const lists = new SafeWeakMap<Storage, { prefix: string; keys: string[] }>();
    const forget = (real: Storage): void => { lists.delete(real); };
    const keysOf = (real: Storage): string[] => {
        const t = tier(real);
        if (t) return t.keys();
        const p = prefix();
        const hit = lists.get(real);
        if (hit && hit.prefix === p) return hit.keys;
        const keys: string[] = [];
        const n = ncall(nativeLength, real);
        for (let i = 0; i < n; i++) {
            const k = ncall(nat.key, real, i);
            if (k !== null && sStarts(k, p)) keys.push(k.slice(p.length));
        }
        lists.set(real, { prefix: p, keys });
        return keys;
    };

    wrapMethod<(...a: unknown[]) => unknown>(SP, "getItem", (native, self, args) => {
        const real = realOf(self);
        if (!real || !args.length) return nR.apply(native, self, args);
        const t = tier(real);
        return t ? t.get(String(args[0])) : ncall(nat.getItem, real, prefix() + String(args[0]));
    });
    wrapMethod<(...a: unknown[]) => unknown>(SP, "setItem", (native, self, args) => {
        const real = realOf(self);
        if (!real || args.length < 2) return nR.apply(native, self, args);
        forget(real);
        const t = tier(real);
        if (t) { t.set(String(args[0]), String(args[1])); return undefined; }
        const name = String(args[0]), v = String(args[1]), stored = prefix() + name;
        return asPages(stored, name, () => ncall(nat.setItem, real, stored, v));
    });
    wrapMethod<(...a: unknown[]) => unknown>(SP, "removeItem", (native, self, args) => {
        const real = realOf(self);
        if (!real || !args.length) return nR.apply(native, self, args);
        forget(real);
        const t = tier(real);
        if (t) { t.remove(String(args[0])); return undefined; }
        const name = String(args[0]), stored = prefix() + name;
        return asPages(stored, name, () => ncall(nat.removeItem, real, stored));
    });
    wrapMethod<(...a: unknown[]) => unknown>(SP, "clear", (native, self, args) => {
        const real = realOf(self);
        if (!real) return nR.apply(native, self, args);
        const t = tier(real);
        if (t) { t.clear(); forget(real); return undefined; }
        const p = prefix();
        for (const k of keysOf(real)) ncall(nat.removeItem, real, p + k); // this origin's only
        forget(real);
        return undefined;
    });
    wrapMethod<(...a: unknown[]) => unknown>(SP, "key", (native, self, args) => {
        const real = realOf(self);
        if (!real || !args.length) return nR.apply(native, self, args);
        const i = Number(args[0]) >>> 0; // ToUint32, as the native's unsigned long
        return keysOf(real)[i] ?? null;
    });
    wrapAccessor<number>(SP, "length", {
        get: (get, self) => {
            const real = realOf(self);
            return real ? keysOf(real).length : ncall(get, self);
        },
    });

    /** What page code holds: named properties and enumeration are this origin's keys. */
    const view = (real: Storage): object => {
        let v = viewOf.get(real);
        if (v) return v;
        v = new Proxy(nO.create(SP) as object, {
            get: (_t, p) => {
                if (typeof p === "symbol" || p in SP) return nR.get(SP, p, v);
                const t = tier(real);
                const value = t ? t.get(p) : ncall(nat.getItem, real, prefix() + p);
                return value === null ? undefined : value;
            },
            set: (_t, p, value) => {
                if (typeof p === "symbol") return false;
                forget(real);
                const t = tier(real);
                if (t) t.set(p, String(value));
                else ncall(nat.setItem, real, prefix() + p, String(value));
                return true;
            },
            has: (_t, p) => typeof p === "symbol" || p in SP || (tier(real)?.get(p) ?? ncall(nat.getItem, real, prefix() + p)) !== null,
            deleteProperty: (_t, p) => {
                if (typeof p === "string") {
                    forget(real);
                    const t = tier(real);
                    if (t) t.remove(p);
                    else ncall(nat.removeItem, real, prefix() + p);
                }
                return true;
            },
            ownKeys: () => keysOf(real).slice(),
            getOwnPropertyDescriptor: (_t, p) => {
                if (typeof p !== "string") return undefined;
                const t = tier(real);
                const value = t ? t.get(p) : ncall(nat.getItem, real, prefix() + p);
                return value === null ? undefined : { value, writable: true, enumerable: true, configurable: true };
            },
            defineProperty: (_t, p, d) => {
                if (typeof p !== "string" || !("value" in d)) return false;
                forget(real);
                const t = tier(real);
                if (t) t.set(p, String(d.value));
                else ncall(nat.setItem, real, prefix() + p, String(d.value));
                return true;
            },
        });
        viewOf.set(real, v);
        views.set(v, real);
        return v;
    };
    for (const name of ["localStorage", "sessionStorage"]) {
        if (!nO.getOwnPropertyDescriptor(targetWindow, name)) continue;
        wrapAccessor<unknown>(targetWindow, name, {
            get: (get, self) => {
                const real = ncall(get, self) as Storage | null; // a sandboxed frame: the native throws
                return real && typeof real === "object" ? view(real) : real;
            },
        });
    }

    // ── storage events ──────────────────────────────────────────────────
    // Another window's write fires `storage` here whatever site it belongs
    // to: other origins' events stop before any page listener.
    const SE = g["StorageEvent"]?.prototype as object | undefined;
    const keyGet = SE ? (nO.getOwnPropertyDescriptor(SE, "key")?.get as ((this: unknown) => string | null) | undefined) : undefined;
    const areaGet = SE ? (nO.getOwnPropertyDescriptor(SE, "storageArea")?.get as ((this: unknown) => Storage | null) | undefined) : undefined;
    const newValueGet = SE ? (nO.getOwnPropertyDescriptor(SE, "newValue")?.get as ((this: unknown) => string | null) | undefined) : undefined;
    if (SE && keyGet) {
        const listen = (g["EventTarget"]?.prototype as EventTarget | undefined)?.addEventListener;
        if (listen) ncall(listen, targetWindow, "storage", (e: Event) => {
            let k: string | null;
            try { k = ncall(keyGet, e); } catch { return; }
            const area = areaGet ? ncall(areaGet, e) : null;
            if (area) forget(area);
            if (area && k !== null && sStarts(k, prefix())) {
                const t = tier(area);
                const nv = newValueGet ? (ncall(newValueGet, e) as string | null) : null;
                if (t) t.external(k.slice(prefix().length), nv);
            }
            // (key null: a clear() — the native clear is never called by a proxied page.)
            if (k === null || !sStarts(k, prefix())) e.stopImmediatePropagation();
        }, true);
        wrapAccessor<string | null>(SE, "key", {
            get: (get, self) => {
                const k = ncall(get, self);
                const p = prefix();
                return k !== null && sStarts(k, p) ? k.slice(p.length) : k;
            },
        });
        if (nO.getOwnPropertyDescriptor(SE, "url")) {
            wrapAccessor<string>(SE, "url", { get: (get, self) => unwrapOne(ncall(get, self)) });
        }
        // Page code hands its storage (the view) to `new StorageEvent(…,
        // {storageArea})` and initStorageEvent: the native takes only a real
        // Storage, so the view becomes its real one there (macys: "Failed
        // to convert value to 'Storage'"). The init dictionary is read
        // through a Proxy so the page's own members are read once each, in
        // the native's order, and its object is not changed.
        const real = (v: unknown): unknown => (typeof v === "object" && v !== null && views.get(v)) || v;
        wrapConstructor(targetWindow as unknown as object, "StorageEvent", (native, args, newTarget) => {
            const next = args.slice();
            const init = next[1];
            if (typeof init === "object" && init !== null) {
                next[1] = new Proxy(init, {
                    get: (t, k, r) => { const v = nR.get(t, k, r); return k === "storageArea" ? real(v) : v; },
                });
            }
            return nR.construct(native as unknown as new (...a: unknown[]) => object, next, newTarget as never) as object;
        });
        wrapMethod<(...a: unknown[]) => void>(SE, "initStorageEvent", (native, self, args) => {
            const next = args.slice();
            if (next.length > 7) next[7] = real(next[7]);
            return nR.apply(native, self, next) as void;
        });
        if (areaGet) {
            wrapAccessor<unknown>(SE, "storageArea", {
                get: (get, self) => {
                    const a = ncall(get, self) as Storage | null;
                    return a ? view(a) : a;
                },
            });
        }
    }
}
