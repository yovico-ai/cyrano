import { SafeWeakMap, nO, nR } from "./intrinsics";
// What an object is, asked without touching it.
//
// Rewritten code passes arbitrary page objects through the runtime (R5's
// `wrap_member_expression(obj, key)`, `obj.top`, `obj.location`, …), and
// natively `obj[key]` performs exactly one [[Get]] on obj. Reading
// `obj.window` or `obj.nodeType` to find out whether obj is a window or a
// document is visible to a getter or a Proxy trap — the kind of
// introspection anti-tamper code does (Ad-Shield). A native accessor called
// with obj as its receiver checks the platform object's brand instead:
// it answers for a window or document of any same-origin realm and throws
// for anything else (a Proxy, a plain object), firing no trap.

const windowGetter = ((): (() => unknown) | undefined => {
    try {
        const g = nO.getOwnPropertyDescriptor(globalThis, "window")?.get;
        return typeof g === "function" ? (g as () => unknown) : undefined;
    } catch {
        return undefined;
    }
})();

const nodeTypeGetter = ((): (() => unknown) | undefined => {
    try {
        const N = (globalThis as { Node?: { prototype: object } }).Node;
        const g = N ? nO.getOwnPropertyDescriptor(N.prototype, "nodeType")?.get : undefined;
        return typeof g === "function" ? (g as () => unknown) : undefined;
    } catch {
        return undefined;
    }
})();

// Asking costs a throw for everything that is not one — tens of
// microseconds — and rewritten code asks for every `obj.parent`, `obj.top`,
// `obj.location`: a page walking a large tree asked millions of times
// (warframe.market: 26 s of a 35 s load). Two accessors are [LegacyLenientThis]
// in Web IDL — Window's onmouseenter, Document's onreadystatechange: with a
// receiver of another kind they return undefined, throwing nothing and
// touching nothing (no trap of a Proxy fires), and for their own kind give
// null or the handler. They sort out everything that is not a candidate;
// only a candidate reaches the accessor that throws.
const lenient = (holder: object | undefined, name: string): (() => unknown) | undefined => {
    try {
        const g = holder ? nO.getOwnPropertyDescriptor(holder, name)?.get : undefined;
        // (Lenient here? A browser that throws instead is left to the exact check.)
        return typeof g === "function" && nR.apply(g, {}, []) === undefined ? (g as () => unknown) : undefined;
    } catch {
        return undefined;
    }
};
const lenientWindow = windowGetter ? lenient(globalThis, "onmouseenter") : undefined;
const lenientDocument = lenient((globalThis as { Document?: { prototype: object } }).Document?.prototype, "onreadystatechange");

// Without a lenient accessor the answers are remembered per object instead
// (a brand never changes).
const windowVerdicts = new SafeWeakMap<object, boolean>();
const documentVerdicts = new SafeWeakMap<object, boolean>();

/** Not a candidate: the lenient accessor says obj is of another kind. */
function ruledOut(g: (() => unknown) | undefined, obj: object): boolean {
    if (!g) return false;
    try {
        return nR.apply(g, obj, []) === undefined;
    } catch {
        return false; // a cross-origin window: the exact check answers
    }
}

function exact(verdicts: SafeWeakMap<object, boolean>, remember: boolean, obj: object, test: () => boolean): boolean {
    if (remember) {
        const known = verdicts.get(obj);
        if (known !== undefined) return known;
    }
    let verdict: boolean;
    try {
        verdict = test();
    } catch {
        verdict = false;
    }
    if (remember) verdicts.set(obj, verdict);
    return verdict;
}

/** Whether obj is a Window this realm can reach (not a cross-origin one). */
export function isWindowObject(obj: unknown): obj is Window {
    if (obj === null || typeof obj !== "object") return false;
    if (!windowGetter) return emulatedWindow(obj);
    if (ruledOut(lenientWindow, obj)) return false;
    return exact(windowVerdicts, !lenientWindow, obj, () => nR.apply(windowGetter, obj, []) === obj);
}

// Without the browser's accessor — a DOM emulation (happy-dom, unit tests)
// defines `window` as a data property; a worker has none — a window is an
// object whose own `window` data property is itself. A browser page never
// takes this path.
function emulatedWindow(obj: object): boolean {
    try {
        const d = nO.getOwnPropertyDescriptor(obj, "window");
        return d !== undefined && "value" in d && d.value === obj;
    } catch {
        return false;
    }
}

/** Whether obj is a Document. */
export function isDocumentObject(obj: unknown): obj is Document {
    if (obj === null || typeof obj !== "object" || !nodeTypeGetter) return false;
    if (ruledOut(lenientDocument, obj)) return false;
    return exact(documentVerdicts, !lenientDocument, obj, () => nR.apply(nodeTypeGetter, obj, []) === 9);
}

// A Location's `href` getter (an unforgeable own accessor of each Location;
// a WorkerLocation's is on its prototype): called with anything that is not
// a Location it throws, firing no trap.
const locationHrefGetter = ((): (() => unknown) | undefined => {
    try {
        const loc = (globalThis as { location?: object }).location;
        if (!loc) return undefined;
        for (let o: object | null = loc; o; o = nO.getPrototypeOf(o) as object | null) {
            const g = nO.getOwnPropertyDescriptor(o, "href")?.get;
            if (typeof g === "function") return g as () => unknown;
        }
        return undefined;
    } catch {
        return undefined;
    }
})();

/**
 * Whether obj is a Location (or WorkerLocation) — what a bare `location`
 * reaches when no binding of the page's shadows it. A local `var location =
 * el.parentNode` is not one (Divi's late-CSS loader, helpmates.com). A
 * cross-origin window's Location (unreadable) counts as one.
 */
export function isLocationObject(obj: unknown): boolean {
    if (obj === null || typeof obj !== "object" || !locationHrefGetter) return false;
    try {
        nR.apply(locationHrefGetter, obj, []);
        return true;
    } catch (e) {
        return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "SecurityError";
    }
}
