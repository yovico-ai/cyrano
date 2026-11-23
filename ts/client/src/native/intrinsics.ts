// The built-ins the runtime calls, saved when the bundle loads — before any
// page script runs.
//
// Page code can replace almost every built-in: `WeakMap.prototype.get`,
// `Function.prototype.call`, `Reflect.apply`, `Object.defineProperty`, …
// Anti-tamper scripts do (Ad-Shield, for its integrity checks), and a
// replaced built-in is page code: it sees every call the runtime makes
// through it (a tell), and, rewritten itself, it runs R5 accesses that
// overwrite `$__crn_key__` in the middle of one of the page's own.
// The runtime therefore calls these saved copies, never the live globals.
//
// Covered: Reflect, Object's statics, Object.prototype's methods,
// call/apply/bind, the keyed collections, queueMicrotask, and the String /
// Array methods polyfill libraries replace (startsWith, endsWith, includes,
// padStart: sStarts … aIncludes — mountaineers.org's Plone bundle made
// startsWith a RegExp, and "[" threw in the runtime's cookie setter). Not
// covered (left as known gap — far more sites, rarely hooked): the other
// Array / String / RegExp methods and the iteration protocol (for…of,
// spread).
//
// The collections are subclasses whose prototypes hold their own copies of
// the native methods: a method lookup on an instance stops there and never
// reaches the page-writable `WeakMap.prototype` etc. Their instances never
// reach page code.

type AnyFn = (...a: unknown[]) => unknown;

function copyOf<T extends object>(source: T): T {
    const out = Object.create(null) as Record<PropertyKey, unknown>;
    for (const k of Reflect.ownKeys(source)) {
        const d = Reflect.getOwnPropertyDescriptor(source, k);
        if (d && typeof d.value === "function") out[k] = d.value;
    }
    return Object.freeze(out) as T;
}

/** Reflect, as it was. */
export const nR: typeof Reflect = copyOf(Reflect);
/** Object's static methods, as they were. */
export const nO: ObjectConstructor = copyOf(Object);
/** Object.prototype's methods, as they were (call them with `ncall`). */
export const nOP: Object = copyOf(Object.prototype);

const reflectApply = nR.apply;

/** `f.call(self, ...args)`, without Function.prototype.call. */
export function ncall<R>(f: (...a: never[]) => R, self: unknown, ...args: unknown[]): R {
    return reflectApply(f as unknown as AnyFn, self, args) as R;
}

/** `f.apply(self, args)`, without Function.prototype.apply (array-like or nullish args, as apply takes them). */
export function napply<R>(f: (...a: never[]) => R, self: unknown, args?: ArrayLike<unknown> | null): R {
    return reflectApply(f as unknown as AnyFn, self, args ?? []) as R;
}

const nativeBind = Function.prototype.bind;
/** `f.bind(self, ...args)`, without reading Function.prototype.bind. */
export function nbind<F extends AnyFn | ((...a: never[]) => unknown)>(f: F, self: unknown, ...args: unknown[]): F {
    return reflectApply(nativeBind as AnyFn, f, [self, ...args]) as F;
}

const SP = String.prototype;
const nStartsWith = SP.startsWith, nEndsWith = SP.endsWith, nStrIncludes = SP.includes, nPadStart = SP.padStart, nToLowerCase = SP.toLowerCase, nCharCodeAt = SP.charCodeAt;
const nArrIncludes = Array.prototype.includes;
/** `s.startsWith(p, at)`, as it was. */
export const sStarts = (s: string, p: string, at?: number): boolean => reflectApply(nStartsWith as AnyFn, s, at === undefined ? [p] : [p, at]) as boolean;
/** `s.endsWith(p)`, as it was. */
export const sEnds = (s: string, p: string): boolean => reflectApply(nEndsWith as AnyFn, s, [p]) as boolean;
/** `s.includes(p)`, as it was. */
export const sIncludes = (s: string, p: string): boolean => reflectApply(nStrIncludes as AnyFn, s, [p]) as boolean;
/** `s.padStart(n, f)`, as it was. */
export const sPadStart = (s: string, n: number, f?: string): string => reflectApply(nPadStart as AnyFn, s, f === undefined ? [n] : [n, f]) as string;
/** `s.toLowerCase()`, as it was. */
export const sLower = (s: string): string => reflectApply(nToLowerCase as AnyFn, s, []) as string;
export const sCode = (s: string, i: number): number => reflectApply(nCharCodeAt as AnyFn, s, [i]) as number;
/** `a.includes(x)`, as it was. */
export const aIncludes = <T>(a: readonly T[], x: T): boolean => reflectApply(nArrIncludes as AnyFn, a, [x]) as boolean;

/** queueMicrotask, as it was (absent in some test realms). */
export const nqueueMicrotask: (cb: () => void) => void = ((): ((cb: () => void) => void) => {
    const q = (globalThis as { queueMicrotask?: (cb: () => void) => void }).queueMicrotask;
    if (typeof q === "function") return (cb) => reflectApply(q as AnyFn, globalThis, [cb]);
    return (cb) => { void Promise.resolve().then(cb); };
})();

// Pins the native methods (and accessors, e.g. `size`) of `base` onto
// `sub`'s prototype.
function pin(sub: { prototype: object }, base: { prototype: object }): void {
    for (const k of nR.ownKeys(base.prototype)) {
        if (k === "constructor") continue;
        const d = nR.getOwnPropertyDescriptor(base.prototype, k);
        if (d) nR.defineProperty(sub.prototype, k, d);
    }
}

export class SafeWeakMap<K extends WeakKey, V> extends WeakMap<K, V> {}
export class SafeWeakSet<T extends WeakKey> extends WeakSet<T> {}
export class SafeMap<K, V> extends Map<K, V> {}
export class SafeSet<T> extends Set<T> {}
pin(SafeWeakMap, WeakMap);
pin(SafeWeakSet, WeakSet);
pin(SafeMap, Map);
pin(SafeSet, Set);
