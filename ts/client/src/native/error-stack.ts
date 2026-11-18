// Error stacks, as page code sees them natively (V8 / Chromium).
//
// Every script of a proxied page is loaded from a proxied URL, so a stack
// lists /cyrano/… URLs, and cyrano's own runtime frames (its wrappers)
// appear in it. Natively a stack names the original script URLs and no
// cyrano frame. Anti-bot scripts read stacks (Turnstile submits one).
//
// V8 formats a stack with Error.prepareStackTrace, read from the realm's
// built-in Error. Cyrano's formatter is installed there; it drops runtime
// frames and shows each frame's original URL. Natively Error has no
// prepareStackTrace until the page sets one, so the page's global `Error`
// is a Proxy of the built-in that reports prepareStackTrace exactly as the
// page has set, defined or deleted it — and the page's own formatter, if
// any, is called with the filtered call sites, original URLs in place.
// Error.prototype.constructor and the native error subclasses' [[Prototype]]
// point at the Proxy, so `e.constructor === Error` and
// `Object.getPrototypeOf(TypeError) === Error` hold.
//
// Heuristic (REQUIREMENTS.md): V8 only; a page that captured the built-in
// before cyrano ran, or that compares realms' intrinsics, can still tell.

import { maskAs, replaceValue } from "./surface";

type CallSite = {
    getFileName(): string | null | undefined;
    getScriptNameOrSourceURL?(): string | null | undefined;
    toString(): string;
};
type PrepareStackTrace = (err: unknown, sites: CallSite[]) => unknown;

const SUBCLASSES = ["TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError"];

let rawMode = false;

/**
 * The script URLs on the current call stack, innermost first, as the engine
 * really has them (proxied), without the page's formatter or stack limit
 * taking part. Used to find which window's code is calling.
 */
export function rawStackUrls(ErrorCtor: ErrorConstructor): string[] {
    const E = ErrorCtor as unknown as { new (): Error; stackTraceLimit: number | undefined; prepareStackTrace?: unknown };
    const limit = E.stackTraceLimit;
    // Without cyrano's formatter in this realm, keep the page's out of it.
    const ownFormatter = shownErrors.has(ErrorCtor);
    const hadPrep = !ownFormatter && Object.prototype.hasOwnProperty.call(E, "prepareStackTrace");
    const prep = hadPrep ? E.prepareStackTrace : undefined;
    let stack = "";
    rawMode = true;
    try {
        if (hadPrep) E.prepareStackTrace = undefined;
        E.stackTraceLimit = 50;
        stack = String(new E().stack ?? "");
    } catch {
        stack = "";
    } finally {
        rawMode = false;
        E.stackTraceLimit = limit;
        if (hadPrep) E.prepareStackTrace = prep;
    }
    const out: string[] = [];
    for (const m of stack.matchAll(/((?:https?|blob|file):[^\s()]+?):\d+:\d+/g)) out.push(m[1]!);
    return out;
}

export function patchErrorStacks(
    targetWindow: Window,
    runtimeUrl: string,
    unwrapOne: (url: string) => string,
): void {
    const g = targetWindow as unknown as Record<string, unknown>;
    const Intrinsic = g["Error"] as ErrorConstructor & { prepareStackTrace?: unknown };
    if (typeof Intrinsic !== "function" || typeof (Intrinsic as { captureStackTrace?: unknown }).captureStackTrace !== "function") return;
    if (installed.has(Intrinsic)) return;
    installed.add(Intrinsic);

    // What the page has done with Error.prepareStackTrace.
    let pageHas = Object.prototype.hasOwnProperty.call(Intrinsic, "prepareStackTrace");
    let pageHook: unknown = Intrinsic.prepareStackTrace;

    const ours = (site: CallSite): boolean => site.getFileName?.() === runtimeUrl;
    const shown = (site: CallSite): CallSite => {
        const file = site.getFileName?.();
        if (!file) return site;
        const original = unwrapOne(file);
        if (original === file) return site;
        return new Proxy(site, {
            get(t, k) {
                if (k === "getFileName" || k === "getScriptNameOrSourceURL") return () => original;
                if (k === "toString") return () => t.toString().split(file).join(original);
                const v = Reflect.get(t, k, t) as unknown;
                return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
            },
        });
    };
    const header = (err: unknown): string => {
        try { return (targetWindow as unknown as { Error: ErrorConstructor }).Error.prototype.toString.call(err); } catch { return "Error"; }
    };
    const format: PrepareStackTrace = (err, sites) => {
        if (rawMode) return [header(err), ...sites.map((s) => `    at ${s.toString()}`)].join("\n");
        const visible = sites.filter((s) => !ours(s)).map(shown);
        if (typeof pageHook === "function") return (pageHook as PrepareStackTrace)(err, visible);
        return [header(err), ...visible.map((s) => `    at ${s.toString()}`)].join("\n");
    };
    Object.defineProperty(Intrinsic, "prepareStackTrace", { value: format, writable: true, configurable: true, enumerable: false });

    const KEY = "prepareStackTrace";
    const pageDescriptor = (): PropertyDescriptor => ({ value: pageHook, writable: true, enumerable: true, configurable: true });
    const Shown: ErrorConstructor = new Proxy(Intrinsic, {
        get(t, k, r): unknown { return k === KEY ? (pageHas ? pageHook : undefined) : Reflect.get(t, k, r === Shown ? t : r); },
        set(t, k, v, r): boolean {
            if (k === KEY) { pageHas = true; pageHook = v; return true; }
            return Reflect.set(t, k, v, r === Shown ? t : r);
        },
        has(t, k) { return k === KEY ? pageHas : Reflect.has(t, k); },
        ownKeys(t) {
            const keys = Reflect.ownKeys(t).filter((k) => k !== KEY);
            return pageHas ? [...keys, KEY] : keys;
        },
        getOwnPropertyDescriptor(t, k) {
            if (k === KEY) return pageHas ? pageDescriptor() : undefined;
            return Reflect.getOwnPropertyDescriptor(t, k);
        },
        defineProperty(t, k, d) {
            if (k === KEY) { pageHas = true; pageHook = d.value; return true; }
            return Reflect.defineProperty(t, k, d);
        },
        deleteProperty(t, k) {
            if (k === KEY) { pageHas = false; pageHook = undefined; return true; }
            return Reflect.deleteProperty(t, k);
        },
    });
    maskAs(Shown, Intrinsic);
    shownErrors.add(Shown);
    replaceValue(Intrinsic.prototype, "constructor", Shown);
    for (const name of SUBCLASSES) {
        const Sub = g[name];
        if (typeof Sub === "function" && Object.getPrototypeOf(Sub) === Intrinsic) Object.setPrototypeOf(Sub, Shown);
    }
    replaceValue(targetWindow, "Error", Shown);
}

const installed = new WeakSet<object>();
const shownErrors = new WeakSet<object>();
