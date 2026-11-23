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

import { SafeMap, SafeWeakMap, SafeWeakSet, nO, nOP, nR, nbind, ncall, sStarts } from "./intrinsics";
import { maskAs, replaceValue, standIn } from "./surface";

type CallSite = {
    getFileName(): string | null | undefined;
    getScriptNameOrSourceURL?(): string | null | undefined;
    getEvalOrigin?(): string | undefined;
    isEval?(): boolean;
    getFunctionName?(): string | null;
    getLineNumber?(): number | null;
    getColumnNumber?(): number | null;
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
    const hadPrep = !ownFormatter && ncall(nOP.hasOwnProperty, E, "prepareStackTrace");
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
    return stackUrls(stack);
}

// spec/Stack.agda: a V8 frame is "at LOCATION" or "at NAME (LOCATION)"; a
// location is URL:LINE:COL (the URL unescaped: it may hold parentheses),
// a URL alone, or "eval at NAME (LOCATION), POSITION".
const schemeOK = (s: string): boolean => sStarts(s, "http:") || sStarts(s, "https:") || sStarts(s, "blob:") || sStarts(s, "file:");
const locStart = (s: string): boolean => sStarts(s, "eval at ") || schemeOK(s);

/** The text after the first " (" that a location follows, or null. */
function openAt(s: string, from = 0): string | null {
    for (let i = from; i + 1 < s.length; i++) {
        if (s.charCodeAt(i) === 32 && s.charCodeAt(i + 1) === 40 && locStart(s.slice(i + 2))) return s.slice(i + 2);
    }
    return null;
}

function location(rest: string): string {
    if (rest.length > 0 && rest.charCodeAt(rest.length - 1) === 41) {
        const loc = openAt(rest);
        if (loc !== null) return loc.slice(0, -1);
    }
    if (sStarts(rest, "async ") && locStart(rest.slice(6))) return rest.slice(6); // a bare async frame
    return rest;
}

const isDigit = (c: number): boolean => c >= 48 && c <= 57;

/** URL:LINE:COL → URL; a URL without a position as it is. */
function stripPos(u: string): string {
    let i = u.length;
    const digitsBack = (): boolean => { const end = i; while (i > 0 && isDigit(u.charCodeAt(i - 1))) i--; return i < end; };
    if (!digitsBack() || i === 0 || u.charCodeAt(--i) !== 58) return u;
    if (!digitsBack() || i === 0 || u.charCodeAt(--i) !== 58) return u;
    return u.slice(0, i);
}

function urlOf(loc: string, fuel: number): string | null {
    if (fuel <= 0) return null;
    if (sStarts(loc, "eval at ")) {
        const r = loc.slice(8);
        // NAME (LOCATION) and a position, or (an inner eval) none
        const close = r.length > 0 && r.charCodeAt(r.length - 1) === 41 ? r.length - 1 : r.lastIndexOf("), ");
        if (close === -1) return null;
        const inner = openAt(r.slice(0, close));
        return inner === null ? null : urlOf(inner, fuel - 1);
    }
    return schemeOK(loc) ? stripPos(loc) : null;
}

/** The http(s), blob: and file: script URLs of a V8 stack, innermost first. */
export function stackUrls(stack: string): string[] {
    const out: string[] = [];
    const lines = stack.split("\n");
    for (let k = 0; k < lines.length; k++) {
        let l = lines[k]!;
        let a = 0;
        while (a < l.length && l.charCodeAt(a) === 32) a++;
        l = l.slice(a);
        if (!sStarts(l, "at ")) continue;
        const rest = l.slice(3);
        const u = urlOf(location(rest), rest.length);
        if (u !== null) out[out.length] = u;
    }
    return out;
}

// spec/Stack.agda evalOrigin / untag: the eval origin V8 writes for a
// function made with `new Function`, and a tagged script's frame text put
// back as V8 writes it natively.
export function evalOrigin(name: string, loc: string): string {
    return `eval at ${name === "" ? "<anonymous>" : name} (${loc})`;
}
export function untag(tag: string, origin: string, s: string): string {
    const parts = s.split(tag);
    let out = parts[0]!;
    for (let i = 1; i < parts.length; i++) out += (parts[i]!.charCodeAt(0) === 58 ? `${origin}, <anonymous>` : origin) + parts[i]!;
    return out;
}

// The scripts the runtime made for page code's `new Function`, by the
// //# sourceURL it gave them: their native eval origin.
const TAG = `crn-fn-${Math.floor(Math.random() * 1e9).toString(36)}-`;
let tagCount = 0;
const tagged = new SafeMap<string, string>();
// Each whole tag (…-1 is not …-12), as untag puts it back.
const TAG_RE = new RegExp(`${TAG}\\d+(?!\\d)(:?)`, "g");
const untagAll = (s: string): string => s.replace(TAG_RE, (m: string, colon: string) => {
    const o = tagged.get(colon ? m.slice(0, -1) : m);
    return o === undefined ? m : colon ? `${o}, <anonymous>:` : o;
});
const isTag = (s: unknown): boolean => typeof s === "string" && tagged.has(s);
const originNow = new SafeWeakMap<object, () => string | null>();
const callerNow = new SafeWeakMap<object, () => string | null>();

/** The original URL of the script calling into the runtime now (a page's, never the runtime's), or null. */
export function callerScriptUrl(targetWindow: object): string | null {
    const now = callerNow.get(targetWindow);
    try { return now ? now() : null; } catch { return null; }
}

/**
 * A `new Function` body, tagged so that its frames show the eval origin
 * V8 gives such code natively: the page's calling frame, not the
 * runtime's stand-in. A body that names its own sourceURL is left: its
 * frames show that name, natively too.
 */
export function tagFunctionBody(targetWindow: object, body: string): string {
    if (/\/\/[#@]\s*sourceURL=/.test(body)) return body;
    const now = originNow.get(targetWindow);
    const origin = now ? now() : null;
    if (origin === null) return body;
    // One tag per eval origin: the same body made at the same place is the
    // same source, which V8's compilation cache then serves, as natively
    // (a tag per call made every source new, and the table grow).
    let tag = tagOf.get(origin);
    if (tag === undefined) {
        tag = `${TAG}${++tagCount}`;
        tagOf.set(origin, tag);
        tagged.set(tag, origin);
    }
    return `${body}\n//# sourceURL=${tag}`;
}
const tagOf = new SafeMap<string, string>();

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
    const pageHad = nO.getOwnPropertyDescriptor(Intrinsic, "prepareStackTrace");
    const KEY = "prepareStackTrace";
    // The page's formatter and stack limit, as it has them on the `Error`
    // it holds (the stand-in below).
    const pageHook = (): unknown => {
        try { return (Shown as unknown as Record<string, unknown>)[KEY]; } catch { return undefined; }
    };
    const syncLimit = (): void => {
        try {
            const d = nO.getOwnPropertyDescriptor(Shown, "stackTraceLimit");
            const I = Intrinsic as unknown as { stackTraceLimit?: unknown };
            if (!d) { delete I.stackTraceLimit; return; }
            const v = "value" in d ? d.value as unknown : (d.get ? ncall(d.get, Shown) as unknown : undefined);
            if (I.stackTraceLimit !== v) I.stackTraceLimit = v;
        } catch { /* stays as it is */ }
    };

    const ours = (site: CallSite): boolean => site.getFileName?.() === runtimeUrl;
    // An eval origin as natively: tags put back, the script's original URL.
    const unwrapIn = (t: string, eo: string): string => {
        const u = urlOf(eo, eo.length);
        return u === null ? t : t.split(u).join(unwrapOne(u));
    };
    const originShown = (eo: string): string => { const t = untagAll(eo); return unwrapIn(t, t); };
    const shown = (site: CallSite): CallSite => {
        const file = site.getFileName?.();
        if (!file) {
            const eo = site.isEval?.() ? site.getEvalOrigin?.() : undefined;
            if (typeof eo !== "string") return site;
            const fixed = originShown(eo);
            const sn = site.getScriptNameOrSourceURL?.();
            if (fixed === eo && !isTag(sn)) return site;
            return new Proxy(site, {
                get(t, k) {
                    if (k === "getEvalOrigin") return () => fixed;
                    if (k === "getScriptNameOrSourceURL") return () => (isTag(sn) ? undefined : sn);
                    if (k === "toString") return () => unwrapIn(untagAll(t.toString()), untagAll(eo));
                    const v = nR.get(t, k, t) as unknown;
                    return typeof v === "function" ? nbind((v as (...a: unknown[]) => unknown), t) : v;
                },
            });
        }
        const original = unwrapOne(file);
        if (original === file) return site;
        return new Proxy(site, {
            get(t, k) {
                if (k === "getFileName" || k === "getScriptNameOrSourceURL") return () => original;
                if (k === "toString") return () => t.toString().split(file).join(original);
                const v = nR.get(t, k, t) as unknown;
                return typeof v === "function" ? nbind((v as (...a: unknown[]) => unknown), t) : v;
            },
        });
    };
    // The eval origin V8 would write for code the page's current caller
    // makes now: its frame's function name and the call's location.
    let sitesMode = false;
    // (A stack is costly in proportion to its frames: a few first — the
    // runtime's own frames above the page's are few — and more only when
    // they were all the runtime's. qidian.com's bot check makes thousands
    // of functions; a 30-frame capture each blocked its page for a minute.)
    const callerSite = (): CallSite | null => {
        const I = Intrinsic as unknown as { new (): Error; stackTraceLimit: number | undefined };
        const limit = I.stackTraceLimit;
        for (const depth of [8, 30]) {
            let sites: unknown;
            sitesMode = true;
            try { I.stackTraceLimit = depth; sites = new I().stack; } catch { sites = null; } finally { sitesMode = false; I.stackTraceLimit = limit; }
            if (!Array.isArray(sites)) return null;
            const found = (sites as CallSite[]).find((x) => !ours(x));
            if (found) return found;
            if (sites.length < depth) return null; // the whole stack was the runtime's
        }
        return null;
    };
    // The original URL of the script whose code is calling now (of the one
    // that made it, for eval / Function code): what import() in code it
    // makes resolves against natively.
    callerNow.set(targetWindow, () => {
        const caller = callerSite();
        if (!caller) return null;
        if (caller.isEval?.()) {
            const eo = caller.getEvalOrigin?.();
            if (typeof eo !== "string") return null;
            const t = originShown(eo);
            return urlOf(t, t.length);
        }
        const f = caller.getFileName?.();
        return f ? unwrapOne(f) : null;
    });
    originNow.set(targetWindow, () => {
        const caller = callerSite();
        if (!caller) return null;
        let loc: string;
        if (caller.isEval?.()) {
            const eo = caller.getEvalOrigin?.();
            if (typeof eo !== "string") return null;
            loc = originShown(eo);
        } else {
            const f = caller.getFileName?.();
            if (!f) return null;
            loc = `${unwrapOne(f)}:${caller.getLineNumber?.() ?? 0}:${caller.getColumnNumber?.() ?? 0}`;
        }
        // A Function-made script's top level: V8 calls its frame "eval", its origin "<anonymous>".
        const name = caller.getFunctionName?.() ?? "";
        return evalOrigin(caller.isEval?.() && name === "eval" ? "" : name, loc);
    });
    const header = (err: unknown): string => {
        try { return ncall((targetWindow as unknown as { Error: ErrorConstructor }).Error.prototype.toString, err); } catch { return "Error"; }
    };
    const format: PrepareStackTrace = (err, sites) => {
        if (sitesMode) return sites;
        if (rawMode) return [header(err), ...sites.map((s) => `    at ${s.toString()}`)].join("\n");
        let visible = sites.filter((s) => !ours(s)).map(shown);
        // The limit the page set on its `Error` since the last error was made.
        const limit = (Shown as unknown as { stackTraceLimit?: unknown }).stackTraceLimit;
        if (typeof limit === "number" && limit >= 0 && visible.length > limit) visible = visible.slice(0, Math.floor(limit));
        syncLimit();
        const hook = pageHook();
        if (typeof hook === "function") return ncall((hook as PrepareStackTrace), Shown, err, visible);
        return [header(err), ...visible.map((s) => `    at ${s.toString()}`)].join("\n");
    };
    nO.defineProperty(Intrinsic, KEY, { value: format, writable: true, configurable: true, enumerable: false });

    // The page's `Error`: a function of its own standing in for the
    // built-in (native/surface.ts standIn — a Proxy here would be told, and
    // every native error class inherits from it). It makes its errors with
    // the built-in; `prepareStackTrace` and `stackTraceLimit` on it are the
    // page's own, read by the formatter above — the limit is copied to the
    // built-in, where V8 reads it, whenever an error is made through it.
    const Shown: ErrorConstructor = standIn(Intrinsic as ErrorConstructor, {
        apply(target, self, args) { syncLimit(); return nR.apply(target, self, args); },
        construct(target, args, newTarget) {
            syncLimit();
            return nR.construct(target, args, (newTarget === Shown ? target : newTarget) as ErrorConstructor) as object;
        },
    });
    // standIn copied the built-in's static members, cyrano's formatter among them.
    delete (Shown as unknown as Record<string, unknown>)[KEY];
    if (pageHad) nO.defineProperty(Shown, KEY, pageHad);
    const capture = (Intrinsic as unknown as { captureStackTrace: (...a: unknown[]) => unknown }).captureStackTrace;
    const captureDesc = nO.getOwnPropertyDescriptor(Intrinsic, "captureStackTrace");
    if (captureDesc) {
        nO.defineProperty(Shown, "captureStackTrace", {
            ...captureDesc,
            value: maskAs(standIn(capture, { apply(target, self, args) { syncLimit(); return nR.apply(target, self === Shown ? Intrinsic : self, args); } }), capture),
        });
    }
    maskAs(Shown, Intrinsic);
    shownErrors.add(Shown);
    replaceValue(Intrinsic.prototype, "constructor", Shown);
    for (const name of SUBCLASSES) {
        const Sub = g[name];
        if (typeof Sub === "function" && nO.getPrototypeOf(Sub) === Intrinsic) nO.setPrototypeOf(Sub, Shown);
    }
    replaceValue(targetWindow, "Error", Shown);
}

const installed = new SafeWeakSet<object>();
const shownErrors = new SafeWeakSet<object>();
