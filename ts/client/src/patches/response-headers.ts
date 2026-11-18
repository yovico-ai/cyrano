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

import { wrapMethod } from "../native/surface";
import { crossOriginXhr, exposedBy, type Exposed } from "./cors";

const CARRIER = "crn-h";

type Originals = Record<string, string[] | null>;

function parse(raw: string | null): Originals | null {
    if (!raw) return null;
    try {
        const o = JSON.parse(raw) as unknown;
        return typeof o === "object" && o !== null ? (o as Originals) : null;
    } catch {
        return null;
    }
}

/** A realm's view of response headers, for the fetch wrapper. */
export interface HeaderViews {
    /** The origin's value of a header, whatever is exposed. */
    original(headers: object, name: string): string | null;
    /** From now on `headers` shows only what `allow` admits. */
    expose(headers: object, allow: Exposed): void;
}
const viewsOf = new WeakMap<object, HeaderViews>();
export const headerViewsOf = (realm: object): HeaderViews | undefined => viewsOf.get(realm);

export function patchResponseHeaders(targetWindow: Window): void {
    const g = targetWindow as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

    // ── fetch: Headers ──────────────────────────────────────────────────
    const HeadersCtor = g["Headers"] as (new (init?: Array<[string, string]>) => Headers) | undefined;
    const H = HeadersCtor?.prototype as Headers | undefined;
    if (HeadersCtor && H) {
        const nativeGet = H.get;
        const nativeForEach = H.forEach;
        const cache = new WeakMap<object, { raw: string | null; allow: Exposed | undefined; shown: Headers }>();
        const exposed = new WeakMap<object, Exposed>();
        /** The headers a script is shown, or null when they are the object's own. */
        const view = (self: unknown, allow: Exposed | undefined): Headers | null => {
            let raw: string | null;
            try { raw = nativeGet.call(self, CARRIER); } catch { return null; } // not a Headers: the native throws
            const orig = parse(raw);
            if (!orig && !allow) return null;
            const hit = cache.get(self as object);
            if (hit && hit.raw === raw && hit.allow === allow) return hit.shown;
            let pairs: Array<[string, string]> = [];
            nativeForEach.call(self, (value: string, name: string) => {
                if (name !== CARRIER && !(orig && name in orig)) pairs.push([name, value]);
            });
            if (orig) for (const name of Object.keys(orig)) for (const v of orig[name] ?? []) pairs.push([name, v]);
            if (allow) pairs = pairs.filter(([name]) => allow(name.toLowerCase()));
            const out = new HeadersCtor(pairs);
            cache.set(self as object, { raw, allow, shown: out });
            return out;
        };
        const shown = (self: unknown): Headers | null =>
            view(self, typeof self === "object" && self !== null ? exposed.get(self) : undefined);
        viewsOf.set(targetWindow, {
            original: (headers, name) => nativeGet.call(view(headers, undefined) ?? headers, name),
            expose: (headers, allow) => { exposed.set(headers, allow); },
        });
        for (const key of ["get", "has", "entries", "keys", "values", "getSetCookie", Symbol.iterator] as const) {
            if (!(key in H)) continue;
            wrapMethod<(...a: unknown[]) => unknown>(H, key, (native, self, args) => Reflect.apply(native, shown(self) ?? self, args));
        }
        wrapMethod<(...a: unknown[]) => unknown>(H, "forEach", (native, self, args) => {
            const s = shown(self);
            if (!s || typeof args[0] !== "function") return Reflect.apply(native, self, args);
            const cb = args[0] as (...a: unknown[]) => unknown;
            // The callback's third argument is the Headers object the page holds.
            return Reflect.apply(native, s, [function (this: unknown, v: unknown, k: unknown) { return cb.call(this, v, k, self); }, ...args.slice(1)]);
        });
    }

    // ── XMLHttpRequest ──────────────────────────────────────────────────
    const X = (g["XMLHttpRequest"] as { prototype: XMLHttpRequest } | undefined)?.prototype;
    if (X) {
        const nativeOne = X.getResponseHeader;
        const credentialed = Object.getOwnPropertyDescriptor(X, "withCredentials")?.get as ((this: unknown) => boolean) | undefined;
        const originalsOf = (self: unknown): Originals | null => {
            try { return parse(nativeOne.call(self, CARRIER)); } catch { return null; }
        };
        /** What a cross-origin XHR's response exposes; undefined for a same-origin one. */
        const exposedOf = (self: unknown, orig: Originals | null): Exposed | undefined => {
            if (typeof self !== "object" || self === null || !crossOriginXhr.has(self)) return undefined;
            const name = "access-control-expose-headers";
            let list: string | null;
            try { list = orig && name in orig ? (orig[name]?.join(", ") ?? null) : nativeOne.call(self, name); } catch { return undefined; }
            let creds = false;
            try { creds = !!credentialed?.call(self); } catch { /* not an XHR */ }
            return exposedBy(list, creds);
        };
        wrapMethod<(...a: unknown[]) => string | null>(X, "getResponseHeader", (native, self, args) => {
            const orig = args.length ? originalsOf(self) : null;
            const allow = args.length ? exposedOf(self, orig) : undefined;
            if (!orig && !allow) return Reflect.apply(native, self, args) as string | null;
            const name = String(args[0]).toLowerCase();
            if (name === CARRIER) return null;
            if (allow && !allow(name)) return null;
            if (orig && name in orig) return orig[name] ? orig[name]!.join(", ") : null;
            return Reflect.apply(native, self, args) as string | null;
        });
        wrapMethod<(...a: unknown[]) => string>(X, "getAllResponseHeaders", (native, self, args) => {
            const all = Reflect.apply(native, self, args) as string;
            const orig = originalsOf(self);
            const allow = exposedOf(self, orig);
            if ((!orig && !allow) || !all) return all;
            const lines = new Map<string, string>();
            for (const line of all.split("\r\n")) {
                const i = line.indexOf(":");
                if (i <= 0) continue;
                const name = line.slice(0, i).toLowerCase();
                if (name !== CARRIER && !(orig && name in orig)) lines.set(name, line);
            }
            if (orig) for (const name of Object.keys(orig)) if (orig[name]) lines.set(name, name + ": " + orig[name]!.join(", "));
            return [...lines.keys()].filter((n) => !allow || allow(n)).sort().map((n) => lines.get(n)! + "\r\n").join("");
        });
    }
}
