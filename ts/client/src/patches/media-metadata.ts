// Media Session artwork (visitoslo.com, 2026-11-23: YouTube's player set
// navigator.mediaSession.metadata with artwork, and the browser fetched the
// image itself, from its origin). Each artwork `src` given to MediaMetadata
// — by its constructor or the artwork setter — is proxified; the artwork
// getter reads the page's URLs back (resolved, as the native resolves them,
// in a frozen array of frozen copies, a new one each read as the native's).

import { nO, nR, ncall } from "../native/intrinsics";
import { wrapAccessor, wrapConstructor } from "../native/surface";

type Image = { src?: unknown } & Record<string, unknown>;

export function patchMediaMetadata(targetWindow: Window, rewriteOne: (url: string) => string, unwrapOne: (url: string) => string): void {
    const g = targetWindow as unknown as { MediaMetadata?: { prototype: object } };
    if (!g.MediaMetadata) return;
    /** A copy of the page's artwork list with each src proxified (other values as given). */
    const proxified = (list: unknown): unknown => {
        if (list === null || typeof list !== "object" || typeof (list as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== "function") return list;
        const out: unknown[] = [];
        for (const item of list as Iterable<unknown>) {
            if (item === null || typeof item !== "object" || !("src" in (item as object))) { out[out.length] = item; continue; }
            const copy: Image = {};
            for (const k of nO.keys(item as object)) copy[k] = (item as Image)[k];
            copy.src = rewriteOne(String((item as Image).src));
            out[out.length] = copy;
        }
        return out;
    };
    wrapConstructor<new (init?: unknown) => object>(targetWindow, "MediaMetadata", (Native, args, newTarget) => {
        const init = args[0];
        if (init !== null && typeof init === "object" && "artwork" in (init as object)) {
            const copy: Record<string, unknown> = {};
            for (const k of ["title", "artist", "album", "chapterInfo"]) if (k in (init as object)) copy[k] = (init as Record<string, unknown>)[k];
            for (const k of nO.keys(init as object)) if (!(k in copy)) copy[k] = (init as Record<string, unknown>)[k];
            copy.artwork = proxified((init as Record<string, unknown>).artwork);
            return nR.construct(Native, [copy, ...args.slice(1)], newTarget as never) as object;
        }
        return nR.construct(Native, args, newTarget as never) as object;
    });
    wrapAccessor<unknown>(g.MediaMetadata.prototype, "artwork", {
        get: (get, self) => {
            const native = ncall(get, self);
            if (!Array.isArray(native)) return native;
            // (A new array each read, as the native's.)
            return nO.freeze(native.map((it: Image) => {
                const c: Image = {};
                for (const k of nO.keys(it)) c[k] = it[k];
                if (typeof it.src === "string") c.src = unwrapOne(it.src);
                return nO.freeze(c);
            }));
        },
        set: (set, self, value) => ncall(set, self, proxified(value)),
    });
}
