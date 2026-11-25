// Response headers, as the origin sent them.
//
// The proxy changes some headers for the browser's sake (a translated CSP,
// a neutralized Alt-Svc, the rewritten body's Content-Length …) and carries
// the origin's values in one header, `Crn-H`: a JSON object from lowercase
// name to the values sent (null: the origin sent no such header). Go:
// proxy/original_headers.go.
//
// A script reading a response — fetch's Headers, XHR's getResponseHeader /
// getAllResponseHeaders — is shown the origin's headers, and never `Crn-H`.
//
// Of a cross-origin response it is shown only the headers CORS exposes
// (cors.ts): fetch marks such a response's Headers, an XHR opened to
// another origin is judged by its own Access-Control-Expose-Headers.

import { SafeMap, SafeWeakMap, nO, nR, ncall } from "../native/intrinsics";
import { wrapAccessor, wrapMethod } from "../native/surface";
import { crossOriginXhr, exposedBy, type Exposed } from "./cors";

const CARRIER = "crn-h";

type Originals = Record<string, string[] | null>;

/** The origin's reason phrase Crn-H carries (spec/Carry.agda statusText), under a name no header has. */
const STATUS_TEXT = ":status-text";

function parseAll(raw: string | null): Originals | null {
    if (!raw) return null;
    try {
        const o = JSON.parse(raw) as unknown;
        return typeof o === "object" && o !== null ? (o as Originals) : null;
    } catch {
        return null;
    }
}

/** The headers Crn-H carries (the phrase is not one). */
function parse(raw: string | null): Originals | null {
    const o = parseAll(raw);
    if (!o || !(STATUS_TEXT in o)) return o;
    const out: Originals = {};
    for (const k of nO.keys(o)) if (k !== STATUS_TEXT) out[k] = o[k]!;
    return out; // (a carrier with the phrase alone is a carrier still: never shown)
}

/** The phrase Crn-H carries, or null. */
function phraseOf(raw: string | null): string | null {
    const v = parseAll(raw)?.[STATUS_TEXT];
    return v && typeof v[0] === "string" ? v[0] : null;
}

/** A realm's view of response headers, for the fetch wrapper. */
export interface HeaderViews {
    /** The origin's value of a header, whatever is exposed. */
    original(headers: object, name: string): string | null;
    /** From now on `headers` shows only what `allow` admits. */
    expose(headers: object, allow: Exposed): void;
}
const viewsOf = new SafeWeakMap<object, HeaderViews>();
export const headerViewsOf = (realm: object): HeaderViews | undefined => viewsOf.get(realm);

/**
 * `opaque`: the context's origin is opaque to the browser (a sandboxed
 * document, a data: worker). Its requests to the proxy are cross-origin, so
 * the browser itself shows an XHR only what CORS exposes — the origin's own
 * answer — and refuses the carrier ("Refused to get unsafe header"): XHR's
 * header methods stay native there.
 */
export function patchResponseHeaders(targetWindow: Window, opaque = false): void {
    const g = targetWindow as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    // Headers#get as it is before the wrapping below (statusText reads the carrier through it).
    const headersGet = (g["Headers"] as { prototype?: Headers } | undefined)?.prototype?.get;

    // ── fetch: Headers ──────────────────────────────────────────────────
    const HeadersCtor = g["Headers"] as (new (init?: Array<[string, string]>) => Headers) | undefined;
    const H = HeadersCtor?.prototype as Headers | undefined;
    if (HeadersCtor && H) {
        const nativeGet = H.get;
        const nativeForEach = H.forEach;
        const cache = new SafeWeakMap<object, { raw: string | null; allow: Exposed | undefined; shown: Headers }>();
        const exposed = new SafeWeakMap<object, Exposed>();
        /** The headers a script is shown, or null when they are the object's own. */
        const view = (self: unknown, allow: Exposed | undefined): Headers | null => {
            let raw: string | null;
            try { raw = ncall(nativeGet, self, CARRIER); } catch { return null; } // not a Headers: the native throws
            const orig = parse(raw);
            // The runtime's own request headers on a Request the page holds
            // (cors.ts) are not the page's to see either.
            let marked = false;
            try { marked = ncall(nativeGet, self, "crn-i") !== null || ncall(nativeGet, self, "crn-c") !== null; } catch { marked = false; }
            if (!orig && !allow && !marked) return null;
            const hit = cache.get(self as object);
            if (hit && hit.raw === raw && hit.allow === allow && !marked) return hit.shown;
            let pairs: Array<[string, string]> = [];
            ncall(nativeForEach, self, (value: string, name: string) => {
                if (name !== CARRIER && name !== "crn-i" && name !== "crn-c" && !(orig && name in orig)) pairs.push([name, value]);
            });
            if (orig) for (const name of nO.keys(orig)) for (const v of orig[name] ?? []) pairs.push([name, v]);
            if (allow) pairs = pairs.filter(([name]) => allow(name.toLowerCase()));
            const out = new HeadersCtor(pairs);
            cache.set(self as object, { raw, allow, shown: out });
            return out;
        };
        const shown = (self: unknown): Headers | null =>
            view(self, typeof self === "object" && self !== null ? exposed.get(self) : undefined);
        viewsOf.set(targetWindow, {
            original: (headers, name) => ncall(nativeGet, view(headers, undefined) ?? headers, name),
            expose: (headers, allow) => { exposed.set(headers, allow); },
        });
        for (const key of ["get", "has", "entries", "keys", "values", "getSetCookie", Symbol.iterator] as const) {
            if (!(key in H)) continue;
            wrapMethod<(...a: unknown[]) => unknown>(H, key, (native, self, args) => nR.apply(native, shown(self) ?? self, args));
        }
        wrapMethod<(...a: unknown[]) => unknown>(H, "forEach", (native, self, args) => {
            const s = shown(self);
            if (!s || typeof args[0] !== "function") return nR.apply(native, self, args);
            const cb = args[0] as (...a: unknown[]) => unknown;
            // The callback's third argument is the Headers object the page holds.
            return nR.apply(native, s, [function (this: unknown, v: unknown, k: unknown) { return ncall(cb, this, v, k, self); }, ...args.slice(1)]);
        });
    }

    // ── statusText: an HTTP/1.x origin's reason phrase (the browser spoke
    // HTTP/2 to the proxy, which has none: round I) ─────────────────────
    const R = (g["Response"] as { prototype: object } | undefined)?.prototype;
    const nHeaders = R ? nO.getOwnPropertyDescriptor(R, "headers")?.get : undefined;
    if (R && nHeaders && headersGet && nO.getOwnPropertyDescriptor(R, "statusText")?.get) {
        const nGet = headersGet;
        wrapAccessor<string>(R, "statusText", {
            get: (get, self) => {
                const v = ncall(get, self) as string;
                let raw: string | null = null;
                try { raw = ncall(nGet, ncall(nHeaders, self) as object, CARRIER) as string | null; } catch { raw = null; }
                return phraseOf(raw) ?? v;
            },
        });
    }

    // ── XMLHttpRequest ──────────────────────────────────────────────────
    const X = (g["XMLHttpRequest"] as { prototype: XMLHttpRequest } | undefined)?.prototype;
    if (X && !opaque) {
        const nativeOne = X.getResponseHeader;
        const credentialed = nO.getOwnPropertyDescriptor(X, "withCredentials")?.get as ((this: unknown) => boolean) | undefined;
        const originalsOf = (self: unknown): Originals | null => {
            try { return parse(ncall(nativeOne, self, CARRIER)); } catch { return null; }
        };
        /** What a cross-origin XHR's response exposes; undefined for a same-origin one. */
        const exposedOf = (self: unknown, orig: Originals | null): Exposed | undefined => {
            if (typeof self !== "object" || self === null || !crossOriginXhr.has(self)) return undefined;
            const name = "access-control-expose-headers";
            let list: string | null;
            try { list = orig && name in orig ? (orig[name]?.join(", ") ?? null) : ncall(nativeOne, self, name); } catch { return undefined; }
            let creds = false;
            try { creds = !!(credentialed && ncall(credentialed, self)); } catch { /* not an XHR */ }
            return exposedBy(list, creds);
        };
        wrapMethod<(...a: unknown[]) => string | null>(X, "getResponseHeader", (native, self, args) => {
            const orig = args.length ? originalsOf(self) : null;
            const allow = args.length ? exposedOf(self, orig) : undefined;
            if (!orig && !allow) return nR.apply(native, self, args) as string | null;
            const name = String(args[0]).toLowerCase();
            if (name === CARRIER) return null;
            if (allow && !allow(name)) return null;
            if (orig && name in orig) return orig[name] ? orig[name]!.join(", ") : null;
            return nR.apply(native, self, args) as string | null;
        });
        if (nO.getOwnPropertyDescriptor(X, "statusText")?.get) {
            wrapAccessor<string>(X, "statusText", {
                get: (get, self) => {
                    const v = ncall(get, self) as string;
                    let raw: string | null = null;
                    try { raw = ncall(nativeOne, self, CARRIER) as string | null; } catch { raw = null; }
                    return phraseOf(raw) ?? v;
                },
            });
        }
        wrapMethod<(...a: unknown[]) => string>(X, "getAllResponseHeaders", (native, self, args) => {
            const all = nR.apply(native, self, args) as string;
            const orig = originalsOf(self);
            const allow = exposedOf(self, orig);
            if ((!orig && !allow) || !all) return all;
            const lines = new SafeMap<string, string>();
            for (const line of all.split("\r\n")) {
                const i = line.indexOf(":");
                if (i <= 0) continue;
                const name = line.slice(0, i).toLowerCase();
                if (name !== CARRIER && !(orig && name in orig)) lines.set(name, line);
            }
            if (orig) for (const name of nO.keys(orig)) if (orig[name]) lines.set(name, name + ": " + orig[name]!.join(", "));
            return [...lines.keys()].filter((n) => !allow || allow(n)).sort().map((n) => lines.get(n)! + "\r\n").join("");
        });
    }
}
