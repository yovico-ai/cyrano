// Notification images (round J): the browser fetches a notification's icon,
// image, badge and each action's icon itself, from their origins, outside
// the proxy — as it did Media Session artwork (media-metadata.ts). The
// options reach the native through a view that proxifies those members as
// it reads them (each once, in its own order); the getters read the page's
// URLs back. new Notification and ServiceWorkerRegistration#showNotification.

import { nO, nR, ncall } from "../native/intrinsics";
import { wrapAccessor, wrapConstructor, wrapMethod } from "../native/surface";

const IMAGES = ["icon", "image", "badge"];

export function patchNotification(targetWindow: Window, rewriteOne: (url: string) => string, unwrapOne: (url: string) => string): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    const action = (a: unknown): unknown => (a === null || typeof a !== "object" ? a : new Proxy(a as object, {
        get: (t, k, r) => { const v = nR.get(t, k, r); return k === "icon" && v !== undefined ? rewriteOne(String(v)) : v; },
    }));
    const actions = (list: unknown): unknown => {
        if (list === null || typeof list !== "object" || typeof (list as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== "function") return list;
        const out: unknown[] = [];
        for (const a of list as Iterable<unknown>) out[out.length] = action(a);
        return out;
    };
    const options = (o: unknown): unknown => (o === null || typeof o !== "object" ? o : new Proxy(o as object, {
        get: (t, k, r) => {
            const v = nR.get(t, k, r);
            if (typeof k === "string" && IMAGES.indexOf(k) >= 0 && v !== undefined) return rewriteOne(String(v));
            return k === "actions" ? actions(v) : v;
        },
    }));
    if (g["Notification"]) {
        wrapConstructor<new (...a: unknown[]) => object>(targetWindow, "Notification", (Native, args, newTarget) =>
            nR.construct(Native, args.length > 1 ? [args[0], options(args[1]), ...args.slice(2)] : args, newTarget as never) as object);
        const P = (targetWindow as unknown as { Notification: { prototype: object } }).Notification.prototype;
        for (const k of IMAGES) {
            if (nO.getOwnPropertyDescriptor(P, k)?.get) wrapAccessor<string>(P, k, { get: (get, self) => { const v = ncall(get, self); return typeof v === "string" && v ? unwrapOne(v) : v; } });
        }
        if (nO.getOwnPropertyDescriptor(P, "actions")?.get) {
            wrapAccessor<unknown>(P, "actions", {
                get: (get, self) => {
                    const v = ncall(get, self);
                    if (!Array.isArray(v)) return v;
                    return nO.freeze(v.map((a: Record<string, unknown>) => {
                        const c: Record<string, unknown> = {};
                        for (const k of nO.keys(a)) c[k] = a[k];
                        if (typeof a["icon"] === "string" && a["icon"]) c["icon"] = unwrapOne(a["icon"]);
                        return nO.freeze(c);
                    }));
                },
            });
        }
    }
    const SWR = g["ServiceWorkerRegistration"]?.prototype;
    if (SWR && typeof nO.getOwnPropertyDescriptor(SWR, "showNotification")?.value === "function") {
        wrapMethod<(...a: unknown[]) => unknown>(SWR, "showNotification", (native, self, args) =>
            nR.apply(native, self, args.length > 1 ? [args[0], options(args[1]), ...args.slice(2)] : args));
    }
}
