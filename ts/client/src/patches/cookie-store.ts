// The Cookie Store API (cookieStore.get / getAll / set / delete), as page
// code sees it natively (spec/Cookies.agda cookieStoreSet / Query, as
// Chromium has it). Natively it reads and writes the proxy origin's jar:
// a write for the page's own domain was refused ("Cookie domain must
// domain-match current host" — Google's ad tag stores __gads, __gpi, __eoi
// so, on every site with ads) and a read listed the proxy's channel.
//
// It reads and writes the same memory as document.cookie
// (cookies/memory.ts; spec/CookieJar.agda): a write is checked as Chromium
// checks it, taken into memory and the outbox, and has taken effect when
// its promise resolves; a read lists, from memory, the cookies for the
// page's original URL, each item as Chromium makes it (its keys, in their
// order; the expiry to the millisecond). A refusal is the native's own,
// made on the proxy's jar with an already expired cookie.
//
// The native store's change events list the channel's entries: they are
// stopped before any listener of the page's, and the page's own are made
// instead (measured): one per change to a cookie shown at the page's URL —
// a write of this document's (even of the same value), another tab's, a
// response's — dispatched in a later task, its items as Chromium makes
// them (a deleted one: domain, name, partitioned, path, secure, and
// sameSite when the cookie stated one). Gaps: such an event is not
// isTrusted; an expiry from Max-Age has no microseconds; `partitioned` is
// not kept; service workers' cookieStore.
import { nO, nR, ncall } from "../native/intrinsics";
import { wrapMethod } from "../native/surface";
import { cookieStoreDelete, cookieStoreQuery, cookieStoreSet, itemSameSite, matches, type StoredCookie, type StoreErr } from "../cookies/rfc";
import { sameId, type Change } from "../cookies/jar";
import { absorbInbox, knownCookies, liveCookies, onCookieChange, snapshotFirst, writeCookie, type CookieAccess } from "../cookies/memory";
import { cookieAccessor, isPublicSuffix, nowMicro } from "./document-cookie";

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
    const cookieDesc = cookieAccessor((targetWindow as unknown as { document: object }).document) ?? nO.getOwnPropertyDescriptor(DocProto, "cookie");
    const cookieGet = cookieDesc?.get as ((this: unknown) => string) | undefined;
    const cookieSet = cookieDesc?.set as ((this: unknown, v: string) => void) | undefined;
    if (!cookieGet || !cookieSet) return;
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

    const access = (): CookieAccess => ({ get: () => ncall(cookieGet, W.document), set: (v: string) => ncall(cookieSet, W.document, v) });
    const resolved = (v: unknown): Promise<unknown> => nR.apply(P.resolve as AnyFn, P, [v]) as Promise<unknown>;
    // A write, into memory and the outbox: in effect when its promise resolves.
    const write = (ch: Change): Promise<unknown> => {
        snapshotFirst(targetWindow, baseUrl());
        const a = access();
        writeCookie(targetWindow, a, ch, absorbInbox(targetWindow, a));
        return resolved(undefined);
    };
    // An item as Chromium makes it: these keys, in this order.
    const item = (c: StoredCookie): Item => {
        const k = knownCookies(targetWindow).find((x) => sameId(x.change.cookie, c));
        const e = k && !k.change.expiry.session ? k.change.expiry.until : null;
        return { domain: c.hostOnly ? null : c.domain, expires: e, name: c.name, partitioned: false, path: c.path,
            sameSite: itemSameSite(c.sameSite), secure: c.secure, value: c.value };
    };
    const query = (name: string | null): Promise<unknown> => {
        snapshotFirst(targetWindow, baseUrl());
        const cs = liveCookies(targetWindow, absorbInbox(targetWindow, access()));
        return resolved(cookieStoreQuery(baseUrl(), name, cs).map(item));
    };
    // A document that may not use cookies (sandboxed): the native's own refusal.
    const allowed = (): boolean => {
        try { ncall(cookieGet, W.document); return true; } catch { return false; }
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
            wrapMethod<AnyFn>(CS.prototype, method, (native, self, args) => {
                if (!allowed()) return nR.apply(native, self, args);
                const n = nameOf(method, args);
                if ("error" in n) return rejected(method, n.error);
                const all = query(n.name);
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
            const now = nowMicro();
            if (expires !== null && expires <= now) return write({ cookie: r, gone: true, expiry: { session: true } });
            return write({ cookie: r, gone: false,
                expiry: expires === null ? { session: true } : { session: false, until: Math.min(expires, now + 400 * 86400 * 1000) } });
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
            return write({ cookie: r, gone: true, expiry: { session: true } });
        }]);
    });

    // The native store's change events list the channel: stopped before any
    // listener of the page's (this one is the first on the store).
    const store = (targetWindow as unknown as { cookieStore?: EventTarget }).cookieStore;
    const ET = (targetWindow as unknown as { EventTarget?: { prototype: EventTarget } }).EventTarget;
    const listen = ET?.prototype.addEventListener;
    const stop = (targetWindow as unknown as { Event?: { prototype: Event } }).Event?.prototype.stopImmediatePropagation;
    const trustedGet = (targetWindow as unknown as { Event?: { prototype: object } }).Event
        ? nO.getOwnPropertyDescriptor((targetWindow as unknown as { Event: { prototype: object } }).Event.prototype, "isTrusted")?.get : undefined;
    const isTrusted = (e: Event): boolean => {
        // isTrusted is an own unforgeable property of each event in Chromium.
        const d = nO.getOwnPropertyDescriptor(e, "isTrusted");
        try { return d?.get ? ncall(d.get as AnyFn, e) === true : trustedGet ? ncall(trustedGet as AnyFn, e) === true : false; } catch { return false; }
    };
    if (store && listen && stop) {
        try {
            ncall(listen as AnyFn, store, "change", (e: Event) => {
                // Only the browser's own (they list the channel); one the page
                // dispatches, or the runtime makes below, goes on.
                if (!isTrusted(e)) return;
                try { absorbInbox(targetWindow, access()); } catch { /* a document that may not read them */ }
                ncall(stop as AnyFn, e);
            });
        } catch { /* no store events here */ }
    }

    // The page's change events, from memory's changes.
    const CCE = (targetWindow as unknown as { CookieChangeEvent?: new (t: string, i: object) => Event }).CookieChangeEvent;
    const dispatch = (ET?.prototype as { dispatchEvent?: AnyFn } | undefined)?.dispatchEvent;
    const MC = (targetWindow as unknown as { MessageChannel?: typeof MessageChannel }).MessageChannel;
    if (!store || !CCE || !dispatch || !MC) return;
    const queue: Event[] = [];
    let port: MessagePort | null = null;
    let post: AnyFn | null = null;
    const afterTask = (ev: Event): void => {
        queue.push(ev);
        if (!port) {
            const mc = new MC();
            port = mc.port2;
            post = mc.port2.postMessage as unknown as AnyFn;
            mc.port1.onmessage = (): void => {
                const ev2 = queue.shift();
                if (ev2) try { ncall(dispatch, store, ev2); } catch { /* the page's listener threw: as natively, reported, not ours */ }
            };
        }
        ncall(post!, port, 0);
    };
    const deletedItem = (c: StoredCookie): Item => {
        const it: Item = { domain: c.hostOnly ? null : c.domain, name: c.name, partitioned: false, path: c.path };
        if (c.sameSite !== "u") it["sameSite"] = itemSameSite(c.sameSite);
        it["secure"] = c.secure;
        return it;
    };
    onCookieChange(targetWindow, (ch) => {
        let url: URL;
        try { url = baseUrl(); } catch { return; }
        if (!matches(true, url, ch.cookie)) return;
        const alive = !ch.gone && (ch.expiry.session || ch.expiry.until > Date.now());
        const ev = new CCE("change", alive
            ? { changed: [{ ...item(ch.cookie), expires: ch.expiry.session ? null : ch.expiry.until }], deleted: [] }
            : { changed: [], deleted: [deletedItem(ch.cookie)] });
        afterTask(ev);
    });
}
