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

import { SafeSet, nO, nR } from "./intrinsics";
import { wrapMethod } from "./surface";

export const HIDDEN = ["$rewriter", "$rewriter_init", "$rewriter_init_worker", "$__crn_key__"];
const hidden = new SafeSet<PropertyKey>(HIDDEN);

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
        return Array.isArray(out) && isGlobal(args[0]) ? out.filter((k) => !hidden.has(k as PropertyKey)) : out;
    };
    wrapMethod<(...a: unknown[]) => unknown>(O, "getOwnPropertyNames", withoutHidden);
    wrapMethod<(...a: unknown[]) => unknown>(R, "ownKeys", withoutHidden);
    const noDescriptor = (native: (...a: unknown[]) => unknown, self: unknown, args: unknown[]): unknown =>
        hidden.has(args[1] as PropertyKey) && isGlobal(args[0]) ? undefined : nR.apply(native, self, args);
    wrapMethod<(...a: unknown[]) => unknown>(O, "getOwnPropertyDescriptor", noDescriptor);
    wrapMethod<(...a: unknown[]) => unknown>(R, "getOwnPropertyDescriptor", noDescriptor);
    wrapMethod<(...a: unknown[]) => unknown>(O, "getOwnPropertyDescriptors", (native, self, args) => {
        const out = nR.apply(native, self, args) as Record<string, unknown>;
        if (out && isGlobal(args[0])) for (const k of HIDDEN) delete out[k];
        return out;
    });
    const notOwn = (native: (...a: unknown[]) => unknown, self: unknown, args: unknown[]): unknown =>
        hidden.has(args[0] as PropertyKey) && isGlobal(self) ? false : nR.apply(native, self, args);
    wrapMethod<(...a: unknown[]) => unknown>(O.prototype, "hasOwnProperty", notOwn);
    if ("hasOwn" in O) {
        wrapMethod<(...a: unknown[]) => unknown>(O, "hasOwn", (native, self, args) =>
            hidden.has(args[1] as PropertyKey) && isGlobal(args[0]) ? false : nR.apply(native, self, args));
    }
}
