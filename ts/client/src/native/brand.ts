import { nO, nR } from "./intrinsics";
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

/** Whether obj is a Window this realm can reach (not a cross-origin one). */
export function isWindowObject(obj: unknown): obj is Window {
    if (obj === null || typeof obj !== "object") return false;
    if (!windowGetter) return emulatedWindow(obj);
    try {
        return nR.apply(windowGetter, obj, []) === obj;
    } catch {
        return false;
    }
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
    try {
        return nR.apply(nodeTypeGetter, obj, []) === 9;
    } catch {
        return false;
    }
}
