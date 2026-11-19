// The location page code sees — for its own window and for any other frame
// (frame.contentWindow.location) — as the native Location of the original
// page.
//
// window.location is [LegacyUnforgeable]: its members are non-configurable
// own properties of the instance and cannot be redefined, so rewritten code
// reaches a *view* instead ($rewriter.wrap_get_location / wrap_location).
// The view is built to read as the native object (REQUIREMENTS.md, the page
// cannot tell):
//   * its prototype is Location.prototype — `instanceof Location`,
//     "[object Location]";
//   * it has the real instance's own members, each with the real
//     descriptor (enumerable, non-configurable), and each function a Proxy
//     of the real instance's own native function, so name, length and
//     toString are native;
//   * reads answer from the original URL; navigations go through URL
//     containment to the real location; a hash change stays in-page;
//   * ancestorOrigins is a Proxy of the real DOMStringList, answering the
//     ancestors' original origins.

import { SafeSet, nO, nOP, nR, ncall, aIncludes } from "../native/intrinsics";
import type { ClientConfig } from "../config";
import { rewriteUrl, unwrapProxiedUrl } from "../url/containment";
import { maskAs, standIn } from "../native/surface";
import { originalOrigin } from "../messaging/target-origin";

export type WrappedLocation = Location;

const PARTS = ["protocol", "host", "hostname", "port", "pathname", "search", "hash"] as const;
type Part = (typeof PARTS)[number];

export interface LocationViewOptions {
    /** The page's original URL, now. */
    base(): URL;
    /** Records an in-page change of the original URL (hash). */
    setBase?(u: URL): void;
    config: ClientConfig;
    /** The window this location belongs to (for ancestorOrigins). */
    win?: Window;
}

export function makeLocationView(real: Location, o: LocationViewOptions): Location {
    const navigate = (method: "assign" | "replace", url: string): void => {
        real[method](rewriteUrl(String(url), o.base(), o.config));
    };
    const setPart = (part: Part, value: string): void => {
        const next = new URL(o.base().href);
        (next as unknown as Record<Part, string>)[part] = String(value);
        if (part === "hash") {
            real.hash = value; // a fragment change: no request, stays in-page
            o.setBase?.(next);
            return;
        }
        navigate("assign", next.href);
    };
    const own = (o2: object, k: string): boolean => ncall(nOP.hasOwnProperty, o2, k);
    // An about:blank or about:srcdoc document's URL is its own: only its
    // base URL (and its origin) come from the document that created it.
    // `location.href` there is "about:blank" and `location.origin` "null".
    const local = (): boolean => { try { return real.protocol === "about:"; } catch { return false; } };
    const getters: Record<string, () => unknown> = {
        href: () => (local() ? real.href : o.base().href),
        origin: () => (local() ? "null" : o.base().origin),
        ancestorOrigins: () => ancestorOriginsView(real, o),
    };
    const setters: Record<string, (v: string) => void> = {
        href: (v) => navigate("assign", v),
    };
    for (const part of PARTS) {
        getters[part] = () => (local() ? real[part] : o.base()[part]);
        setters[part] = (v) => setPart(part, v);
    }
    const methods: Record<string, (...a: unknown[]) => unknown> = {
        assign: (u) => navigate("assign", String(u)),
        replace: (u) => navigate("replace", String(u)),
        reload: () => real.reload(),
        toString: () => (local() ? real.href : o.base().href),
    };

    const view = nO.create(nO.getPrototypeOf(real) as object) as Record<PropertyKey, unknown>;
    const known = new SafeSet<PropertyKey>([...nO.keys(getters), ...nO.keys(methods)]);
    const keys = new SafeSet<PropertyKey>([...nR.ownKeys(real), ...known]);
    for (const k of keys) {
        const d = nO.getOwnPropertyDescriptor(real, k);
        const name = typeof k === "string" ? k : "";
        const next: PropertyDescriptor = {
            enumerable: d ? d.enumerable === true : true,
            configurable: d ? d.configurable === true : false,
        };
        if (own(getters, name) || own(setters, name)) {
            const g = getters[name];
            const s = setters[name];
            if (g) next.get = d?.get ? maskAs(standIn(d.get, { apply: () => g() }), d.get) : g;
            if (s) next.set = d?.set ? maskAs(standIn(d.set, { apply: (_t, _self, a: unknown[]) => s(a[0] as string) }), d.set) : s;
        } else if (own(methods, name)) {
            const m = methods[name]!;
            const native = d?.value as ((...a: unknown[]) => unknown) | undefined;
            next.value = typeof native === "function" ? maskAs(standIn(native, { apply: (_t, _self, a: unknown[]) => m(...a) }), native) : m;
            next.writable = d ? d.writable === true : false;
        } else if (d) {
            // Anything else (valueOf, Symbol.toPrimitive, …): the real member,
            // its functions acting on the real object.
            if ("value" in d) {
                next.value = typeof d.value === "function" && k !== "valueOf"
                    ? maskAs(standIn(d.value as (...a: unknown[]) => unknown, { apply: (t, _self, a: unknown[]) => nR.apply(t, real, a) }), d.value as object)
                    : d.value;
                next.writable = d.writable === true;
            } else {
                if (d.get) next.get = maskAs(standIn(d.get, { apply: (t) => nR.apply(t, real, []) }), d.get);
                if (d.set) next.set = maskAs(standIn(d.set, { apply: (t, _self, a: unknown[]) => nR.apply(t, real, a) }), d.set);
            }
        } else {
            continue;
        }
        nO.defineProperty(view, k, next);
    }
    return view as unknown as Location;
}

/**
 * The location view of another window, or its real location when cyrano
 * does not proxy it (or it is really cross-origin).
 */
export function foreignLocationView(win: unknown, config: ClientConfig): unknown {
    let real: Location;
    try {
        real = (win as { location: Location }).location;
        void real.href;
    } catch {
        return (win as { location?: unknown })?.location;
    }
    const base = (): URL => {
        const r = (win as { $rewriter?: { get_base_url?: () => URL | null } }).$rewriter;
        const b = r?.get_base_url?.();
        if (b) return b;
        const original = unwrapProxiedUrl(real.href, config);
        return new URL(original);
    };
    try {
        if (unwrapProxiedUrl(real.href, config) === real.href && !(win as { $rewriter?: unknown }).$rewriter) return real;
    } catch {
        return real;
    }
    return makeLocationView(real, { base, config, win: win as Window });
}

// ancestorOrigins: a Proxy of the real DOMStringList (so instanceof, the
// toString tag and the prototype's methods are native), answering with the
// ancestors' original origins, nearest first.
function ancestorOriginsView(real: Location, o: LocationViewOptions): unknown {
    const native = (real as unknown as { ancestorOrigins?: object }).ancestorOrigins;
    if (!native) return native;
    const list: string[] = [];
    try {
        let w: Window | undefined = o.win;
        while (w && w !== w.parent) {
            w = w.parent;
            const origin = originalOrigin(w, (h) => unwrapProxiedUrl(h, o.config));
            if (origin === null) {
                try { list.push(new URL(w.location.href).origin); } catch { break; }
            } else {
                list.push(origin);
            }
            if (w === w.top) break;
        }
    } catch { /* no ancestor access */ }
    const proto = nO.getPrototypeOf(native) as Record<PropertyKey, unknown>;
    const item = proto["item"] as object | undefined;
    const contains = proto["contains"] as object | undefined;
    const iter = proto[Symbol.iterator] as object | undefined;
    const index = (k: PropertyKey): number | null =>
        typeof k === "string" && /^(0|[1-9]\d*)$/.test(k) ? Number(k) : null;
    return new Proxy(native, {
        get(t, k) {
            if (k === "length") return list.length;
            const i = index(k);
            if (i !== null) return list[i];
            if (k === "item" && item) return maskAs(standIn(item as (...a: unknown[]) => unknown, { apply: (_t, _s, a: unknown[]) => list[Number(a[0])] ?? null }), item);
            if (k === "contains" && contains) return maskAs(standIn(contains as (...a: unknown[]) => unknown, { apply: (_t, _s, a: unknown[]) => aIncludes(list, String(a[0])) }), contains);
            if (k === Symbol.iterator && iter) return maskAs(standIn(iter as (...a: unknown[]) => unknown, { apply: () => list[Symbol.iterator]() }), iter);
            return nR.get(t, k, t);
        },
        has(t, k) {
            const i = index(k);
            return i !== null ? i < list.length : nR.has(t, k);
        },
        ownKeys() {
            return list.map((_, i) => String(i));
        },
        getOwnPropertyDescriptor(_t, k) {
            const i = index(k);
            return i !== null && i < list.length ? { value: list[i], writable: false, enumerable: true, configurable: true } : undefined;
        },
    });
}
