// The old FileSystem API — webkitRequestFileSystem (TEMPORARY, PERSISTENT)
// and webkitResolveLocalFileSystemURL — per storage key, as the OPFS is
// (spec/Storage.agda fsPath, shownPath).
//
// Every proxied site had the proxy origin's one file system of each type:
// one site's files were found by another (round K's built-in survey). The
// page's root is the real root's directory named for its key (opfsDir),
// made on first use; every path the page gives an entry of it is mapped
// under that directory, never above it (".." stops at the page's root, as
// natively); entries read back the page's paths, names and filesystem:
// URLs (its own origin's); the root's parent is the root; removing or
// moving the root is refused by the real root, in the native's words; the
// file system's name is the page's origin's. Entries of other file systems
// (a drop's, an isolated one's) are left alone. The interfaces have no
// globals: their prototypes are patched when the first file system is
// handed out. Workers too (their key is their origin's, as their other
// storage names are). Limits: the *Sync API is not partitioned; the
// name's port for a default-port origin is not measured.

import { SafeMap, SafeWeakMap, SafeWeakSet, nO, nR, ncall } from "../native/intrinsics";
import { wrapAccessor, wrapMethod } from "../native/surface";
import { opfsDirName } from "./storage";

type Fn = (...a: unknown[]) => unknown;
type Part = { root: object; realRoot: object; rootUrl: string; type: string };

/** spec/Storage.agda fsPath: the real absolute path for `given`, asked of an entry at page path `at`. */
export function fsPath(key: string, at: string, given: string): string {
    const segs: string[] = given.startsWith("/") ? [] : at.split("/").filter((s) => s !== "");
    for (const s of given.split("/")) {
        if (s === "" || s === ".") continue;
        if (s === "..") { segs.pop(); continue; }
        segs.push(s);
    }
    return "/" + opfsDirName(key) + segs.map((s) => "/" + s).join("");
}

/** spec/Storage.agda shownPath: a real path as the page sees it. */
export function shownPath(key: string, real: string): string {
    const root = "/" + opfsDirName(key);
    if (real === root) return "/";
    return real.startsWith(root + "/") ? real.slice(root.length) : real;
}

/** The page's file system name: `<scheme>_<host>_<port>:<Type>` (measured; port 0 when it is the default). */
function fsName(origin: string, type: string): string {
    try {
        const u = new URL(origin);
        const port = u.port !== "" ? u.port : "0";
        return `${u.protocol.slice(0, -1)}_${u.hostname}_${port}:${type}`;
    } catch { return type; }
}

export function patchOldFileSystem(scope: object, key: () => string, pageOrigin: () => string): void {
    const w = scope as { webkitRequestFileSystem?: Fn; webkitResolveLocalFileSystemURL?: Fn };
    const request = w.webkitRequestFileSystem;
    if (typeof request !== "function") return;
    const parts = new SafeWeakMap<object, Part>();
    const patched = new SafeWeakSet<object>();
    let N: { root: Fn; fsNameGet: Fn; fullPath: Fn; toURL: Fn; filesystem: Fn; getDirectory: Fn } | null = null;

    // By file system object, and by type: an entry webkitResolveLocalFileSystemURL
    // hands out has a file system object of its own (a drop's or an isolated
    // one's is of no such type).
    const byType = new SafeMap<string, Part>();
    const typeOf = (fs: object): string => {
        const n = ncall(N!.fsNameGet, fs) as string;
        return n.slice(n.indexOf(":") + 1).toLowerCase();
    };
    const partOfFs = (fs: object): Part | undefined => {
        let p = parts.get(fs);
        if (!p) {
            try { p = byType.get(typeOf(fs)); } catch { p = undefined; }
            if (p) parts.set(fs, p);
        }
        return p;
    };
    const partOf = (entry: unknown): Part | undefined => {
        if (!N || typeof entry !== "object" || entry === null) return undefined;
        try { return partOfFs(ncall(N.filesystem, entry) as object); } catch { return undefined; }
    };
    const isPartRoot = (entry: unknown): boolean => {
        try { return ncall(N!.fullPath, entry) === "/" + opfsDirName(key()); } catch { return false; }
    };
    const getter = (proto: object, k: string): Fn | undefined => nO.getOwnPropertyDescriptor(proto, k)?.get as Fn | undefined;
    const holder = (o: object, k: string): object | null => {
        for (let p: object | null = o; p; p = nO.getPrototypeOf(p) as object | null) if (nO.getOwnPropertyDescriptor(p, k)) return p;
        return null;
    };

    /** Patches the prototypes of a file system and its root, once. */
    const patchProtos = (fs: object, root: object): boolean => {
        const fsP = holder(fs, "root"), entryP = holder(root, "fullPath"), dirP = holder(root, "getDirectory");
        if (!fsP || !entryP || !dirP) return false;
        if (patched.has(fsP)) return true;
        patched.add(fsP);
        const rootGet = getter(fsP, "root"), nameGet = getter(fsP, "name"), fullPath = getter(entryP, "fullPath");
        const filesystem = getter(entryP, "filesystem"), toURL = (entryP as Record<string, unknown>)["toURL"] as Fn;
        const getDirectory = (dirP as Record<string, unknown>)["getDirectory"] as Fn;
        if (!rootGet || !nameGet || !fullPath || !filesystem || !toURL || !getDirectory) return false;
        N = { root: rootGet, fsNameGet: nameGet, fullPath, toURL, filesystem, getDirectory };

        wrapAccessor<unknown>(fsP, "root", { get: (get, self) => partOfFs(self as object)?.root ?? ncall(get, self) });
        wrapAccessor<unknown>(fsP, "name", {
            get: (get, self) => {
                const n = ncall(get, self) as string;
                return partOfFs(self as object) ? fsName(pageOrigin(), n.slice(n.indexOf(":") + 1)) : n;
            },
        });
        wrapAccessor<unknown>(entryP, "fullPath", {
            get: (get, self) => { const p = ncall(get, self) as string; return partOf(self) ? shownPath(key(), p) : p; },
        });
        const nameGetE = getter(entryP, "name");
        if (nameGetE) {
            wrapAccessor<unknown>(entryP, "name", {
                get: (get, self) => { const p = partOf(self); return p && isPartRoot(self) ? "" : ncall(get, self); },
            });
        }
        wrapMethod<Fn>(entryP, "toURL", (native, self, args) => {
            const u = nR.apply(native, self, args) as string;
            const p = partOf(self);
            if (!p || !u.startsWith(p.rootUrl)) return u;
            let rest = u.slice(p.rootUrl.length);
            if (rest.startsWith("/")) rest = rest.slice(1);
            return `filesystem:${pageOrigin()}/${p.type}/${rest}`;
        });
        wrapMethod<Fn>(entryP, "getParent", (native, self, args) => {
            const p = partOf(self);
            if (!p || typeof args[0] !== "function") return nR.apply(native, self, args);
            const ok = args[0] as Fn;
            // the real root (the page root's parent) is the page's root
            return nR.apply(native, self, [(d: unknown) => ok(ncall(N!.fullPath, d) === "/" ? p.root : d), ...args.slice(1)]);
        });
        for (const k of ["remove", "moveTo", "copyTo"]) {
            if (typeof (entryP as Record<string, unknown>)[k] !== "function") continue;
            wrapMethod<Fn>(entryP, k, (native, self, args) => {
                const p = partOf(self);
                return nR.apply(native, p && isPartRoot(self) ? p.realRoot : self, args); // the root: refused as natively
            });
        }
        wrapMethod<Fn>(dirP, "removeRecursively", (native, self, args) => {
            const p = partOf(self);
            return nR.apply(native, p && isPartRoot(self) ? p.realRoot : self, args);
        });
        for (const k of ["getFile", "getDirectory"]) {
            wrapMethod<Fn>(dirP, k, (native, self, args) => {
                const p = partOf(self);
                if (!p || args.length === 0) return nR.apply(native, self, args);
                const at = shownPath(key(), ncall(N!.fullPath, self) as string);
                return nR.apply(native, self, [fsPath(key(), at, String(args[0])), ...args.slice(1)]);
            });
        }
        return true;
    };

    /** Makes (once) the page's root of a native file system, then goes on. */
    const ensure = (fs: unknown, then: () => void, fail: unknown): void => {
        if (typeof fs !== "object" || fs === null) return then();
        if (N && partOfFs(fs)) return then();
        const realRoot = nO.getOwnPropertyDescriptor(holder(fs, "root") ?? {}, "root")?.get;
        const real = realRoot ? ncall(realRoot as Fn, fs) as object : null;
        if (!real || !patchProtos(fs, real)) return then();
        const name = ncall(N!.fsNameGet, fs) as string;
        const type = name.slice(name.indexOf(":") + 1).toLowerCase();
        ncall(N!.getDirectory, real, opfsDirName(key()), { create: true }, (d: object) => {
            const part = { root: d, realRoot: real, rootUrl: ncall(N!.toURL, d) as string, type };
            parts.set(fs, part);
            byType.set(type, part);
            then();
        }, (e: unknown) => { if (typeof fail === "function") (fail as Fn)(e); });
    };

    wrapMethod<Fn>(scope, "webkitRequestFileSystem", (native, self, args) => {
        if (typeof args[2] !== "function") return nR.apply(native, self, args);
        const ok = args[2] as Fn, fail = args[3];
        return nR.apply(native, self, [args[0], args[1], (fs: unknown) => ensure(fs, () => ok(fs), fail), ...args.slice(3)]);
    });

    const resolve = w.webkitResolveLocalFileSystemURL;
    if (typeof resolve !== "function") return;
    wrapMethod<Fn>(scope, "webkitResolveLocalFileSystemURL", (native, self, args) => {
        if (args.length === 0 || typeof args[1] !== "function") return nR.apply(native, self, args);
        const url = String(args[0]);
        const m = /^filesystem:([^/]+\/\/[^/]+)\/(temporary|persistent)\/(.*)$/i.exec(url);
        if (!m || m[1] !== pageOrigin()) return nR.apply(native, self, [url, ...args.slice(1)]); // another origin's: the native's refusal
        const type = m[2]!.toLowerCase();
        let rest = m[3]!;
        try { rest = decodeURIComponent(rest); } catch { /* as written */ }
        const ok = args[1] as Fn, fail = args[2];
        // the page's root of that type first, then the URL under it
        ncall(request, self, type === "persistent" ? 1 : 0, 0, (fs: unknown) => ensure(fs, () => {
            const p = typeof fs === "object" && fs !== null ? partOfFs(fs) : undefined;
            if (!p) return nR.apply(native, self, [url, ...args.slice(1)]);
            const real = fsPath(key(), "/", rest).split("/").map((s) => encodeURIComponent(s)).join("/");
            const at = p.rootUrl.indexOf("/" + p.type + "/");
            const base = p.rootUrl.slice(0, at + p.type.length + 1); // filesystem:<proxy origin>/<type>
            return nR.apply(native, self, [base + real, ok, ...args.slice(2)]);
        }, fail), (e: unknown) => { if (typeof fail === "function") (fail as Fn)(e); });
        return undefined;
    });
}
