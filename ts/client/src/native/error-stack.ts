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
// is a function standing in for the built-in: prepareStackTrace on it is
// only what the page has set, defined or deleted — and the page's own
// formatter, if any, is called with the filtered call sites, original URLs
// in place.
// Error.prototype.constructor and the native error subclasses' [[Prototype]]
// point at the stand-in, so `e.constructor === Error` and
// `Object.getPrototypeOf(TypeError) === Error` hold.
//
// Heuristic (REQUIREMENTS.md): V8 only; a page that captured the built-in
// before cyrano ran, or that compares realms' intrinsics, can still tell.

import { maskAs, replaceValue, standIn } from "./surface";

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

    // What the page had done with Error.prepareStackTrace before this ran.
    const pageHad = Object.getOwnPropertyDescriptor(Intrinsic, "prepareStackTrace");
    const KEY = "prepareStackTrace";
    // The page's formatter and stack limit, as it has them on the `Error`
    // it holds (the stand-in below).
    const pageHook = (): unknown => {
        try { return (Shown as unknown as Record<string, unknown>)[KEY]; } catch { return undefined; }
    };
    const syncLimit = (): void => {
        try {
            const d = Object.getOwnPropertyDescriptor(Shown, "stackTraceLimit");
            const I = Intrinsic as unknown as { stackTraceLimit?: unknown };
            if (!d) { delete I.stackTraceLimit; return; }
            const v = "value" in d ? d.value as unknown : (d.get ? d.get.call(Shown) as unknown : undefined);
            if (I.stackTraceLimit !== v) I.stackTraceLimit = v;
        } catch { /* stays as it is */ }
    };

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
        let visible = sites.filter((s) => !ours(s)).map(shown);
        // The limit the page set on its `Error` since the last error was made.
        const limit = (Shown as unknown as { stackTraceLimit?: unknown }).stackTraceLimit;
        if (typeof limit === "number" && limit >= 0 && visible.length > limit) visible = visible.slice(0, Math.floor(limit));
        syncLimit();
        const hook = pageHook();
        if (typeof hook === "function") return (hook as PrepareStackTrace).call(Shown, err, visible);
        return [header(err), ...visible.map((s) => `    at ${s.toString()}`)].join("\n");
    };
    Object.defineProperty(Intrinsic, KEY, { value: format, writable: true, configurable: true, enumerable: false });

    // The page's `Error`: a function of its own standing in for the
    // built-in (native/surface.ts standIn — a Proxy here would be told, and
    // every native error class inherits from it). It makes its errors with
    // the built-in; `prepareStackTrace` and `stackTraceLimit` on it are the
    // page's own, read by the formatter above — the limit is copied to the
    // built-in, where V8 reads it, whenever an error is made through it.
    const Shown: ErrorConstructor = standIn(Intrinsic as ErrorConstructor, {
        apply(target, self, args) { syncLimit(); return Reflect.apply(target, self, args); },
        construct(target, args, newTarget) {
            syncLimit();
            return Reflect.construct(target, args, (newTarget === Shown ? target : newTarget) as ErrorConstructor) as object;
        },
    });
    // standIn copied the built-in's static members, cyrano's formatter among them.
    delete (Shown as unknown as Record<string, unknown>)[KEY];
    if (pageHad) Object.defineProperty(Shown, KEY, pageHad);
    const capture = (Intrinsic as unknown as { captureStackTrace: (...a: unknown[]) => unknown }).captureStackTrace;
    const captureDesc = Object.getOwnPropertyDescriptor(Intrinsic, "captureStackTrace");
    if (captureDesc) {
        Object.defineProperty(Shown, "captureStackTrace", {
            ...captureDesc,
            value: maskAs(standIn(capture, { apply(target, self, args) { syncLimit(); return Reflect.apply(target, self === Shown ? Intrinsic : self, args); } }), capture),
        });
    }
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
