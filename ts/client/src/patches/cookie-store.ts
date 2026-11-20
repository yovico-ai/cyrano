// The Cookie Store API (cookieStore.get / getAll / set / delete), as page
// code sees it natively (spec/Cookies.agda cookieStoreSet / Query, as
// Chromium has it). Natively it reads and writes the proxy origin's jar:
// a write for the page's own domain was refused ("Cookie domain must
// domain-match current host" — Google's ad tag stores __gads, __gpi, __eoi
// so, on every site with ads) and a read listed the proxy's wire cookies.
//
// A write is checked as Chromium checks it and lands in the browser's jar
// in the wire form document.cookie uses (cookies/rfc.ts), through the
// native document.cookie setter; a read takes the native getAll() — it
// still knows each cookie's expiry — keeps the cookies cyrano wrote, as
// document.cookie selects them for the page's original URL, and gives
// each item its original name, value, domain, path, sameSite and secure.
//
// Not done: change events (CookieChangeEvent) still list the wire
// cookies; `partitioned` is not kept (a partitioned cookie is stored
// unpartitioned); service workers' cookieStore.

import { SafeWeakMap, nO, nR, ncall } from "../native/intrinsics";
import { wrapMethod } from "../native/surface";
import { cookieStoreDelete, cookieStoreQuery, cookieStoreSet, itemSameSite, unwire, wireName, wireValue, type StoredCookie, type StoreErr } from "../cookies/rfc";
import { isPublicSuffix } from "./document-cookie";

// Each refusal, made by the native on the proxy's own jar so that the
// page gets the browser's own TypeError (its message differs between
// Chrome versions): a set that fails in the same check and stores nothing.
const PROBES: Record<Exclude<StoreErr, "malformed">, unknown[]> = {
    emptyNameEq: ["", "a=b"],
    emptyBoth: ["", ""],
    nameEq: ["a=b", "x"],
    domainDot: [{ name: "a", value: "b", domain: ".x" }],
    hostDomain: [{ name: "__Host-a", value: "b", domain: "x" }],
    domainMismatch: [{ name: "a", value: "b", domain: "invalid.invalid" }],
    pathSlash: [{ name: "a", value: "b", path: "x" }],
    hostPath: [{ name: "__Host-a", value: "b", path: "/x" }],
};
const MALFORMED = ["a", "x;y"];

type Item = Record<string, unknown>;
type AnyFn = (...a: unknown[]) => unknown;

/** The name or value itself is what Chromium refuses as malformed. */
const ownFault = (n: string, v: string): boolean =>
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f;]/.test(n + v) || /^[ \t]|[ \t]$/.test(n) || /^[ \t]|[ \t]$/.test(v) || n.includes("=");

/** WebIDL USVString. */
const usv = (v: unknown): string => {
    const s = `${v as string}`;
    const wf = (s as unknown as { toWellFormed?: () => string }).toWellFormed;
    return typeof wf === "function" ? ncall(wf, s) : s;
};

export function patchCookieStore(targetWindow: Window, baseUrl: () => URL): void {
    const CS = (targetWindow as unknown as { CookieStore?: { prototype: object } }).CookieStore;
    const DocProto = (targetWindow as unknown as { Document?: { prototype: object } }).Document?.prototype;
    if (!CS || !DocProto) return;
    const cookieSet = nO.getOwnPropertyDescriptor(DocProto, "cookie")?.set as ((this: unknown, v: string) => void) | undefined;
    if (!cookieSet) return;
    const nativeGetAll = nO.getOwnPropertyDescriptor(CS.prototype, "getAll")?.value as AnyFn | undefined;
    const W = targetWindow as unknown as { Promise: PromiseConstructor; TypeError: TypeErrorConstructor; document: Document };
    const P = W.Promise;
    const then = P.prototype.then as AnyFn;
    const rejected = (method: string, message: string): Promise<unknown> =>
        nR.apply(P.reject as AnyFn, P, [new W.TypeError(`Failed to execute '${method}' on 'CookieStore': ${message}`)]) as Promise<unknown>;
    const nativeSet = nO.getOwnPropertyDescriptor(CS.prototype, "set")?.value as AnyFn | undefined;
    const nativeDelete = nO.getOwnPropertyDescriptor(CS.prototype, "delete")?.value as AnyFn;
    // Chromium's generation (spec/Cookies.agda cookieStoreSet `later`):
    // the later one refuses "=" in a name in words of its own. Asked once,
    // of the native, with a cookie already expired (nothing is stored).
    let later: Promise<boolean> | null = null;
    const generation = (self: unknown): Promise<boolean> => {
        later ??= nR.apply(then, nR.apply(nativeSet!, self, [{ name: "a=b", value: "x", expires: 0 }]), [
            () => false, (e: unknown) => /name cannot contain/i.test(String((e as { message?: unknown })?.message)),
        ]) as Promise<boolean>;
        return later;
    };
    const argsOf = (err: StoreErr, own: unknown[]): unknown[] => (err === "malformed" ? own : PROBES[err]);
    // The native's refusal of `err`; for a malformed name or value, of
    // that very name and value (already expired: nothing is stored).
    const refuse = (self: unknown, err: StoreErr, name: string, value: string): Promise<unknown> => {
        const p = nR.apply(nativeSet!, self, argsOf(err, ownFault(name, value) ? [{ name, value, expires: 0 }] : MALFORMED)) as Promise<unknown>;
        // Accepted after all: the generic refusal.
        return nR.apply(then, p, [() => nR.apply(nativeSet!, self, MALFORMED)]) as Promise<unknown>;
    };

    const write = (c: StoredCookie, expiry: string): void => {
        ncall(cookieSet, W.document, `${wireName(c)}=${wireValue(c)}; Path=/${expiry}`);
    };

    // The cookies cyrano wrote, from the native list; each item kept with its cookie.
    const items = new SafeWeakMap<StoredCookie, Item>();
    const query = (self: unknown, name: string | null): Promise<unknown> => {
        const all = nR.apply(nativeGetAll!, self, []) as Promise<Item[]>;
        return nR.apply(then, all, [(list: Item[]) => {
            const cs: StoredCookie[] = [];
            for (const it of list) {
                const c = unwire(String(it["name"]), String(it["value"]));
                if (c) { cs.push(c); items.set(c, it); }
            }
            return cookieStoreQuery(baseUrl(), name, cs).map((c) => {
                const it = items.get(c)!;
                it["domain"] = c.hostOnly ? null : c.domain;
                it["name"] = c.name;
                it["path"] = c.path;
                it["sameSite"] = itemSameSite(c.sameSite);
                it["secure"] = c.secure;
                it["value"] = c.value;
                return it;
            });
        }]) as Promise<unknown>;
    };

    // get(name) / get(options) and getAll alike: the name asked for, or a refusal.
    const nameOf = (method: string, args: unknown[]): { name: string | null } | { error: string } => {
        const a = args[0];
        if (a === undefined || a === null || typeof a !== "object") {
            if (a === undefined) return method === "get" ? { error: "CookieStoreGetOptions must not be empty" } : { name: null };
            return { name: usv(a) };
        }
        const o = a as { name?: unknown; url?: unknown };
        if (o.name === undefined && o.url === undefined) return method === "get" ? { error: "CookieStoreGetOptions must not be empty" } : { name: null };
        if (o.url !== undefined) {
            let u: URL | null = null;
            try { u = new URL(usv(o.url), baseUrl()); } catch { /* refused below */ }
            if (!u || u.href !== baseUrl().href) return { error: "URL must match the document URL" };
        }
        return { name: o.name === undefined ? null : usv(o.name) };
    };

    if (nativeGetAll) {
        for (const method of ["get", "getAll"] as const) {
            wrapMethod<AnyFn>(CS.prototype, method, (_native, self, args) => {
                const n = nameOf(method, args);
                if ("error" in n) return rejected(method, n.error);
                const all = query(self, n.name);
                return method === "getAll" ? all : nR.apply(then, all, [(xs: Item[]) => xs[0] ?? null]);
            });
        }
    }

    wrapMethod<AnyFn>(CS.prototype, "set", (native, self, args) => {
        let o: { name?: unknown; value?: unknown; domain?: unknown; path?: unknown; sameSite?: unknown; expires?: unknown };
        if (args.length >= 2 && (typeof args[0] !== "object" || args[0] === null)) o = { name: args[0], value: args[1] };
        else if (typeof args[0] === "object" && args[0] !== null) o = args[0] as typeof o;
        else return nR.apply(native, self, args); // the binding's own TypeError
        if (o.name === undefined || o.value === undefined) return nR.apply(native, self, args);
        const ss = o.sameSite === undefined ? "strict" : usv(o.sameSite);
        if (ss !== "strict" && ss !== "lax" && ss !== "none") return nR.apply(native, self, args);
        const domain = o.domain === undefined || o.domain === null ? null : usv(o.domain);
        const name = usv(o.name), value = usv(o.value);
        const path = o.path === undefined ? null : usv(o.path);
        const expires = o.expires === undefined || o.expires === null ? null : Number(o.expires);
        return nR.apply(then, generation(self), [(l: boolean) => {
            const r = cookieStoreSet(l, domain !== null && isPublicSuffix(domain.toLowerCase()), baseUrl(), {
                name, value, domain, path, sameSite: ss === "none" ? "n" : ss === "lax" ? "l" : "t",
            });
            if ("error" in r) return refuse(self, r.error, name, value);
            if (expires !== null && expires <= Date.now()) write(r, "; Max-Age=0");
            else write(r, expires !== null ? `; Expires=${new Date(expires).toUTCString()}` : "");
            return undefined;
        }]);
    });

    wrapMethod<AnyFn>(CS.prototype, "delete", (native, self, args) => {
        const a = args[0];
        let o: { name?: unknown; domain?: unknown; path?: unknown };
        if (typeof a === "object" && a !== null) o = a as typeof o;
        else if (a !== undefined) o = { name: a };
        else return nR.apply(native, self, args);
        if (o.name === undefined) return nR.apply(native, self, args);
        const domain = o.domain === undefined || o.domain === null ? null : usv(o.domain);
        const name = usv(o.name);
        const path = o.path === undefined ? null : usv(o.path);
        return nR.apply(then, generation(self), [(l: boolean) => {
            const r = cookieStoreDelete(l, domain !== null && isPublicSuffix(domain.toLowerCase()), baseUrl(), name, domain, path);
            if ("error" in r) {
                // The native delete refuses the same options in its own
                // words (a malformed name: a name that is so).
                const first = argsOf(r.error, [{ name: ownFault(name, "x") ? name : "a;b" }])[0];
                const probe = (typeof first === "object" && first !== null ? { ...first } : { name: first }) as { value?: unknown; name?: unknown };
                delete probe.value;
                return nR.apply(nativeDelete, self, [probe]);
            }
            write(r, "; Max-Age=0");
            return undefined;
        }]);
    });
}
