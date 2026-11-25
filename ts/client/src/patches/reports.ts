// ReportingObserver reports (round J): a report's `url` named the proxified
// document URL, and one raised by a call through a runtime wrapper (a sync
// XHR's deprecation) named the runtime's own script as `body.sourceFile`.
// Error and RUM agents (Sentry's ReportingObserver integration) collect
// them. A report reads the page's URLs; a source in the runtime reads as a
// call the browser could place nowhere: null, as directly.

import { SafeWeakSet, nO, nR, ncall } from "../native/intrinsics";
import { wrapAccessor, wrapConstructor, wrapMethod } from "../native/surface";

const URL_KEYS = ["url", "documentURL", "blockedURL", "referrer", "sourceFile"];

export function patchReports(targetWindow: Window, unwrapOne: (u: string) => string, runtimeUrl: string): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    const ours = (v: unknown): boolean => typeof v === "string" && (v === runtimeUrl || v.split("?")[0] === runtimeUrl.split("?")[0]);
    const fix = (o: Record<string, unknown>): Record<string, unknown> => {
        const inRuntime = ours(o["sourceFile"]);
        for (const k of URL_KEYS) if (typeof o[k] === "string") o[k] = unwrapOne(o[k] as string);
        if (inRuntime) { o["sourceFile"] = null; if ("lineNumber" in o) o["lineNumber"] = null; if ("columnNumber" in o) o["columnNumber"] = null; }
        if (o["body"] && typeof o["body"] === "object") fix(o["body"] as Record<string, unknown>);
        return o;
    };
    // The Report interface has no global name: its prototype (and its
    // bodies') is patched from the first report the page is given.
    const done = new SafeWeakSet<object>();
    const patchProto = (P: object): void => {
        if (done.has(P)) return;
        done.add(P);
        const sourceGet = nO.getOwnPropertyDescriptor(P, "sourceFile")?.get;
        for (const k of URL_KEYS) {
            if (!nO.getOwnPropertyDescriptor(P, k)?.get) continue;
            wrapAccessor<unknown>(P, k, { get: (get, self) => {
                const v = ncall(get, self);
                if (k === "sourceFile" && ours(v)) return null;
                return typeof v === "string" ? unwrapOne(v) : v;
            } });
        }
        for (const k of ["lineNumber", "columnNumber"]) {
            if (!sourceGet || !nO.getOwnPropertyDescriptor(P, k)?.get) continue;
            wrapAccessor<unknown>(P, k, { get: (get, self) => (ours(ncall(sourceGet, self)) ? null : ncall(get, self)) });
        }
        if (typeof nO.getOwnPropertyDescriptor(P, "toJSON")?.value === "function") {
            wrapMethod<(...a: unknown[]) => unknown>(P, "toJSON", (native, self, args) => {
                const o = ncall(native as (...a: unknown[]) => unknown, self, ...args);
                return o && typeof o === "object" ? fix(o as Record<string, unknown>) : o;
            });
        }
    };
    const bodyGet = (r: object): unknown => { try { return (r as { body?: unknown }).body; } catch { return undefined; } };
    const patchReport = (r: unknown): void => {
        if (!r || typeof r !== "object") return;
        const P = nO.getPrototypeOf(r) as object | null;
        if (P) patchProto(P);
        const b = bodyGet(r as object);
        if (b && typeof b === "object") {
            for (let q = nO.getPrototypeOf(b) as object | null; q && q !== nO.prototype; q = nO.getPrototypeOf(q) as object | null) patchProto(q);
        }
    };
    const patchList = (list: unknown): void => {
        if (Array.isArray(list)) for (const r of list) patchReport(r);
    };
    const RO = g["ReportingObserver"];
    if (!RO) return;
    wrapConstructor<new (...a: unknown[]) => object>(targetWindow, "ReportingObserver", (Native, args, newTarget) => {
        const cb = args[0];
        if (typeof cb !== "function") return nR.construct(Native, args, newTarget as never) as object;
        const shown = function (this: unknown, ...a: unknown[]): unknown { patchList(a[0]); return nR.apply(cb as (...x: unknown[]) => unknown, this, a); };
        return nR.construct(Native, [shown, ...args.slice(1)], newTarget as never) as object;
    });
    const ROP = (targetWindow as unknown as { ReportingObserver: { prototype: object } }).ReportingObserver.prototype;
    if (typeof nO.getOwnPropertyDescriptor(ROP, "takeRecords")?.value === "function") {
        wrapMethod<(...a: unknown[]) => unknown>(ROP, "takeRecords", (native, self, args) => {
            const list = ncall(native as (...a: unknown[]) => unknown, self, ...args);
            patchList(list);
            return list;
        });
    }
}
