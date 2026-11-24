// Window error events (spec/ErrorEvents.agda). Through the proxy every
// script is fetched CORS same-origin, so the browser never mutes one: an
// error a classic script of another origin threw reached the page whole —
// message, the proxified URL, position, the Error — where directly it is
// "Script error.", "", 0, 0, null (round H; error reporters drop muted
// events and send the rest's filename). The runtime mutes as the browser
// would, judged by the script's original URL and whether the page asked
// for CORS (crossorigin as written, or a module), and an event it does not
// mute names the script's original URL, its line and column the first
// frame of the error's stack in that script (the page's Error is the
// runtime's stand-in: V8 took the throw site's).
//
// The ErrorEvent getters and window.onerror's arguments alike; only
// events the browser made (isTrusted); only those naming a proxified URL.
// Gap: a handler written as an onerror attribute (<body onerror>).

import { SafeWeakMap, nO, nOP, nR, ncall, sStarts } from "../native/intrinsics";
import { workerLine } from "../native/error-stack";
import { pageBlobOf } from "./blob-worker-source";
import { wrapAccessor } from "../native/surface";
import { heldAttr, originalAttr } from "../native/originals";

/** spec ErrorEvents.muted. */
export function scriptMuted(sameOrigin: boolean, cors: boolean, isModule: boolean): boolean {
    return !sameOrigin && !cors && !isModule;
}

/** The first `url:line:col` of a stack in the script `url`, or null. */
export function locationIn(stack: string, url: string): [number, number] | null {
    for (const line of stack.split("\n")) {
        const m = /(\S+):(\d+):(\d+)\)?\s*$/.exec(line);
        if (!m) continue;
        const at = m[1]!.replace(/^\(/, "");
        if (at === url) return [Number(m[2]), Number(m[3])];
    }
    return null;
}

type Shown = { muted: boolean; filename: string; lineno: number | null; colno: number | null };

export function patchErrorEvents(targetWindow: Window, proxyOrigin: string, unwrapOne: (u: string) => string, pageOrigin: () => string): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    const EE = g["ErrorEvent"]?.prototype;
    if (!EE) return;
    const get = (k: string): ((this: unknown) => unknown) | undefined => nO.getOwnPropertyDescriptor(EE, k)?.get as ((this: unknown) => unknown) | undefined;
    const nFilename = get("filename"), nError = get("error"), nLineno = get("lineno");
    const targetGet = g["Event"] ? nO.getOwnPropertyDescriptor(g["Event"].prototype, "target")?.get : undefined;
    const isWorker = (t: unknown): boolean => { try { return t !== null && typeof t === "object" && ncall(nOP.toString, t) === "[object Worker]"; } catch { return false; } };
    if (!nFilename || !nError) return;
    const doc = targetWindow.document;
    const scriptsGet = g["Document"] ? nO.getOwnPropertyDescriptor(g["Document"].prototype, "scripts")?.get : undefined;
    const srcGet = g["HTMLScriptElement"] ? nO.getOwnPropertyDescriptor(g["HTMLScriptElement"].prototype, "src")?.get : undefined;
    const lead = proxyOrigin + "/cyrano/";

    const muted = (original: string): boolean => {
        let same = false;
        try { same = new URL(original).origin === pageOrigin(); } catch { same = false; }
        if (same) return false;
        let cors = false, isModule = false;
        try {
            const list = scriptsGet ? ncall(scriptsGet, doc) as ArrayLike<Element> : undefined;
            for (let i = 0; list && i < list.length; i++) {
                const s = list[i]!;
                if (!srcGet || ncall(srcGet, s) !== original) continue;
                const o = originalAttr(s, "crossorigin");
                const written = o !== undefined ? o.value : heldAttr(s, "crossorigin");
                if (written !== null) cors = true;
                if ((heldAttr(s, "type") ?? "").trim().toLowerCase() === "module") isModule = true;
                break;
            }
        } catch { /* judged as not found */ }
        return scriptMuted(false, cors, isModule);
    };
    const seen = new SafeWeakMap<object, Shown | null>();
    const shownOf = (e: unknown): Shown | null => {
        if (typeof e !== "object" || e === null) return null;
        if (seen.has(e)) return seen.get(e)!;
        let out: Shown | null = null;
        try {
            const file = ncall(nFilename, e) as string;
            const pageBlob = typeof file === "string" && sStarts(file, "blob:") ? pageBlobOf.get(file) : undefined;
            if ((e as Event).isTrusted && pageBlob !== undefined && targetGet && isWorker(ncall(targetGet, e))) {
                // A blob: worker's own script (the runtime's rewritten copy):
                // the page's URL, its preamble line taken away.
                const n = ncall(nLineno!, e) as number;
                out = { muted: false, filename: pageBlob, lineno: typeof n === "number" ? workerLine(n) : null, colno: null };
            } else if ((e as Event).isTrusted && typeof file === "string" && sStarts(file, lead)) {
                const original = unwrapOne(file);
                if (muted(original)) {
                    out = { muted: true, filename: "", lineno: 0, colno: 0 };
                } else {
                    let at: [number, number] | null = null;
                    const err = ncall(nError, e) as { stack?: unknown } | null;
                    try { if (err && typeof err === "object" && typeof err.stack === "string") at = locationIn(err.stack, original); } catch { at = null; }
                    // A worker's error, from its own script (not one it
                    // imported, marked !js): the preamble is its first line.
                    let lineno: number | null = at ? at[0] : null;
                    if (lineno === null && targetGet && isWorker(ncall(targetGet, e)) && !/^\/cyrano\/[^/]*!jsc?(\/|$)/.test(file.slice(proxyOrigin.length))) {
                        const n = ncall(nLineno!, e) as number;
                        lineno = typeof n === "number" ? workerLine(n) : null;
                    }
                    out = { muted: false, filename: original, lineno, colno: at ? at[1] : null };
                }
            }
        } catch { out = null; }
        seen.set(e, out);
        return out;
    };
    wrapAccessor<string>(EE, "message", { get: (gt, self) => (shownOf(self)?.muted ? "Script error." : ncall(gt, self)) });
    wrapAccessor<string>(EE, "filename", { get: (gt, self) => shownOf(self)?.filename ?? ncall(gt, self) });
    wrapAccessor<number>(EE, "lineno", { get: (gt, self) => shownOf(self)?.lineno ?? ncall(gt, self) });
    wrapAccessor<number>(EE, "colno", { get: (gt, self) => shownOf(self)?.colno ?? ncall(gt, self) });
    wrapAccessor<unknown>(EE, "error", { get: (gt, self) => (shownOf(self)?.muted ? null : ncall(gt, self)) });

    // window.onerror (and body's / frameset's, which are the window's): its
    // handler is given the event's values as the getters show them.
    const eventGet = nO.getOwnPropertyDescriptor(targetWindow, "event")?.get;
    const handlers = new SafeWeakMap<object, (...a: unknown[]) => unknown>(); // wrapper → the page's
    const wrappers = new SafeWeakMap<object, (...a: unknown[]) => unknown>(); // the page's → wrapper
    const wrap = (f: unknown): unknown => {
        if (typeof f !== "function") return f;
        const had = wrappers.get(f);
        if (had) return had;
        const page = f as (...a: unknown[]) => unknown;
        const w = function (this: unknown, ...args: unknown[]): unknown {
            let ev: unknown;
            try { ev = eventGet ? ncall(eventGet, targetWindow) : undefined; } catch { ev = undefined; }
            const s = ev ? shownOf(ev) : null;
            if (s) {
                if (s.muted) args = ["Script error.", "", 0, 0, null];
                else args = [args[0], s.filename, s.lineno ?? args[2], s.colno ?? args[3], ...args.slice(4)];
            }
            return nR.apply(page, this, args);
        };
        handlers.set(w, page);
        wrappers.set(page, w);
        return w;
    };
    const unwrapHandler = (v: unknown): unknown => (typeof v === "function" ? handlers.get(v) ?? v : v);
    const holders: object[] = [targetWindow];
    for (const k of ["HTMLBodyElement", "HTMLFrameSetElement"]) { const p = g[k]?.prototype; if (p) holders.push(p); }
    for (const h of holders) {
        if (!nO.getOwnPropertyDescriptor(h, "onerror")?.set) continue;
        wrapAccessor<unknown>(h, "onerror", { get: (gt, self) => unwrapHandler(ncall(gt, self)), set: (st, self, v) => { ncall(st, self, wrap(v)); } });
    }
}
