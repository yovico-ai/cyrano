// The runtime's global names, kept out of sight.
//
// Rewritten code reaches the runtime through global identifiers
// (`$rewriter`, `$__crn_key__`; the bundle's entry points
// `$rewriter_init`, `$rewriter_init_worker`), so they must be properties of
// the global object. A script that lists a window's properties — a common
// way to look for automation and tampering — must not find them: they are
// defined non-enumerable (for-in, Object.keys), and the reflection natives
// that list or describe own properties leave them out for global objects.
//
// What cannot be hidden: a script that already knows a name can still read
// it (`window.$rewriter`, `"$rewriter" in window`). This is the heuristic
// limit REQUIREMENTS.md describes.

import { SafeSet, SafeWeakMap, nO, nR } from "./intrinsics";
import { wrapMethod } from "./surface";

export const HIDDEN = ["$rewriter", "$rewriter_init", "$rewriter_init_worker", "$__crn_key__"];
const hidden = new SafeSet<PropertyKey>(HIDDEN);

// Keys the runtime defines on other objects of the page's (Window.prototype's
// accessors for frames reached by name: patches/cross-origin-windows.ts).
const hiddenOn = new SafeWeakMap<object, Set<PropertyKey>>();

/** Hides `key` of `obj` from the reflection natives, as the runtime's globals. */
export function hideOwn(obj: object, key: PropertyKey): void {
    const s = hiddenOn.get(obj);
    if (s) s.add(key); else hiddenOn.set(obj, new SafeSet<PropertyKey>([key]));
}

/** Shows `key` of `obj` again (the runtime took it away). */
export function showOwn(obj: object, key: PropertyKey): void {
    hiddenOn.get(obj)?.delete(key);
}

function isHidden(o: unknown, key: unknown): boolean {
    if (typeof o !== "object" || o === null) return false;
    const s = hiddenOn.get(o);
    if (s && s.has(key as PropertyKey)) return true;
    return hidden.has(key as PropertyKey) && isGlobal(o);
}

function hiddenKeys(o: unknown): Set<PropertyKey> | null {
    if (typeof o !== "object" || o === null) return null;
    const s = hiddenOn.get(o);
    if (isGlobal(o)) return s ? new SafeSet<PropertyKey>([...HIDDEN, ...s]) : hidden;
    return s && s.size ? s : null;
}

/** Defines a runtime global: writable, configurable, not enumerable. */
export function defineHidden(scope: object, name: string, value: unknown): void {
    try {
        nO.defineProperty(scope, name, { value, writable: true, configurable: true, enumerable: false });
    } catch {
        (scope as Record<string, unknown>)[name] = value;
    }
}

/** Whether `o` is a global object (of any realm): its `self` or `window` is itself. */
function isGlobal(o: unknown): boolean {
    if (typeof o !== "object" || o === null) return false;
    try {
        const g = o as { window?: unknown; self?: unknown };
        return g.self === o || g.window === o;
    } catch {
        return false; // a really cross-origin window: the native answers
    }
}

export function patchReflection(realm: object): void {
    const g = realm as unknown as { Object: ObjectConstructor; Reflect: typeof Reflect };
    const O = g.Object;
    const R = g.Reflect;
    if (!O || !R) return;
    const withoutHidden = (native: (...a: unknown[]) => unknown, self: unknown, args: unknown[]): unknown => {
        const out = nR.apply(native, self, args) as unknown;
        const h = Array.isArray(out) ? hiddenKeys(args[0]) : null;
        return h ? (out as PropertyKey[]).filter((k) => !h.has(k)) : out;
    };
    wrapMethod<(...a: unknown[]) => unknown>(O, "getOwnPropertyNames", withoutHidden);
    wrapMethod<(...a: unknown[]) => unknown>(R, "ownKeys", withoutHidden);
    const noDescriptor = (native: (...a: unknown[]) => unknown, self: unknown, args: unknown[]): unknown =>
        isHidden(args[0], args[1]) ? undefined : nR.apply(native, self, args);
    wrapMethod<(...a: unknown[]) => unknown>(O, "getOwnPropertyDescriptor", noDescriptor);
    wrapMethod<(...a: unknown[]) => unknown>(R, "getOwnPropertyDescriptor", noDescriptor);
    wrapMethod<(...a: unknown[]) => unknown>(O, "getOwnPropertyDescriptors", (native, self, args) => {
        const out = nR.apply(native, self, args) as Record<PropertyKey, unknown>;
        const h = out ? hiddenKeys(args[0]) : null;
        if (h) for (const k of h) delete out[k as string];
        return out;
    });
    const notOwn = (native: (...a: unknown[]) => unknown, self: unknown, args: unknown[]): unknown =>
        isHidden(self, args[0]) ? false : nR.apply(native, self, args);
    wrapMethod<(...a: unknown[]) => unknown>(O.prototype, "hasOwnProperty", notOwn);
    if ("hasOwn" in O) {
        wrapMethod<(...a: unknown[]) => unknown>(O, "hasOwn", (native, self, args) =>
            isHidden(args[0], args[1]) ? false : nR.apply(native, self, args));
    }
}
