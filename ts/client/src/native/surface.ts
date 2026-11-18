// The native surface (REQUIREMENTS.md, "the whole native surface"): the one
// way any patch replaces a member of a native browser class.
//
// Page code must see a native where cyrano put a wrapper. Everything a
// script can ask of a function or property is kept as the native's:
//
//   * a method is a Proxy around the native function — `name`, `length`,
//     the absence of `prototype`, non-constructability, and the
//     "Illegal invocation" TypeError on a wrong receiver all stay native;
//   * a constructor is a Proxy too, with `prototype.constructor` pointing
//     back at it, so `instanceof`, statics and `new.target` behave;
//   * an accessor keeps the native descriptor's shape — same object, same
//     enumerable/configurable, a setter where the native has one — with
//     Proxy-wrapped getter/setter (`name` "get URL" etc. kept);
//   * Function.prototype.toString answers for every wrapper what it
//     answers for the native it replaced ("function fetch() { [native
//     code] }"), and for itself.
//
// This is heuristic, not a guarantee (owner, 2026-11-17): page code can
// capture natives before cyrano runs, or probe in ways no wrapper hides.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => unknown;

/** wrapper → the native it stands for (what toString reports). */
const masks = new WeakMap<object, object>();

const installedRealms = new WeakSet<object>();

/**
 * Makes Function.prototype.toString of `realm` report natives for wrappers.
 * Idempotent per realm. Must run before any other patch in that realm.
 */
export function installToStringMask(realm: typeof globalThis): void {
    const FnProto = (realm as { Function?: { prototype?: unknown } }).Function?.prototype as { toString: AnyFn } | undefined;
    if (!FnProto) return;
    if (installedRealms.has(FnProto)) return;
    installedRealms.add(FnProto);
    const nativeToString = FnProto.toString;
    const masked = new Proxy(nativeToString, {
        apply(target, thisArg: unknown, args: unknown[]) {
            const shown = typeof thisArg === "function" || typeof thisArg === "object"
                ? masks.get(thisArg as object) ?? thisArg
                : thisArg;
            return Reflect.apply(target, shown, args);
        },
    });
    masks.set(masked, nativeToString);
    defineLike(FnProto, "toString", { value: masked });
}

/** Records that `wrapper` must read as `native` (for wrappers built elsewhere). */
export function maskAs<T extends object>(wrapper: T, native: object): T {
    masks.set(wrapper, masks.get(native) ?? native);
    return wrapper;
}

/** Where `key` is defined: `owner` or the nearest prototype that has it. */
function holderOf(owner: object, key: PropertyKey): object | null {
    for (let o: object | null = owner; o; o = Object.getPrototypeOf(o) as object | null) {
        if (Object.prototype.hasOwnProperty.call(o, key)) return o;
    }
    return null;
}

/** Redefines `key` on `holder`, keeping the native descriptor's attributes. */
function defineLike(holder: object, key: PropertyKey, change: PropertyDescriptor): void {
    const native = Object.getOwnPropertyDescriptor(holder, key);
    if (!native) return;
    const next: PropertyDescriptor = { configurable: native.configurable === true, enumerable: native.enumerable === true };
    if ("value" in change || "value" in native) {
        next.value = "value" in change ? change.value : native.value;
        next.writable = native.writable === true;
    } else {
        const get = change.get ?? native.get;
        const set = change.set ?? native.set;
        if (get) next.get = get;
        if (set) next.set = set;
    }
    Object.defineProperty(holder, key, next);
}

/** Replaces the value of `key` where it lives, keeping its descriptor. */
export function replaceValue(owner: object, key: PropertyKey, value: unknown): boolean {
    const holder = holderOf(owner, key);
    if (!holder) return false;
    defineLike(holder, key, { value });
    return true;
}

/**
 * Wraps the method `key` of `owner` (looked up on its prototype chain and
 * replaced where it lives). `impl` receives the native and the call's
 * receiver and arguments.
 */
export function wrapMethod<F extends AnyFn>(
    owner: object,
    key: PropertyKey,
    impl: (native: F, self: unknown, args: Parameters<F>) => ReturnType<F>,
): F | undefined {
    const holder = holderOf(owner, key);
    if (!holder) return undefined;
    const native = Object.getOwnPropertyDescriptor(holder, key)?.value as F | undefined;
    if (typeof native !== "function") return undefined;
    const wrapper = new Proxy(native, {
        apply(target, self: unknown, args: unknown[]) {
            return impl(target, self, args as Parameters<F>);
        },
    });
    maskAs(wrapper, native);
    defineLike(holder, key, { value: wrapper });
    return native;
}

/**
 * Wraps the accessor `key`: `get`/`set` receive the native accessor
 * function and the receiver (and value). Either may be omitted to keep the
 * native one.
 */
export function wrapAccessor<T>(
    owner: object,
    key: PropertyKey,
    hooks: {
        get?: (nativeGet: (this: unknown) => T, self: unknown) => T;
        set?: (nativeSet: (this: unknown, v: T) => void, self: unknown, value: T) => void;
    },
): PropertyDescriptor | undefined {
    const holder = holderOf(owner, key);
    if (!holder) return undefined;
    const native = Object.getOwnPropertyDescriptor(holder, key);
    if (!native || (!native.get && !native.set)) return undefined;
    const change: PropertyDescriptor = {};
    if (hooks.get && native.get) {
        const g = native.get as (this: unknown) => T;
        const hook = hooks.get;
        change.get = maskAs(new Proxy(g, { apply: (_t, self: unknown) => hook(g, self) }), g);
    }
    if (hooks.set && native.set) {
        const s = native.set as (this: unknown, v: T) => void;
        const hook = hooks.set;
        change.set = maskAs(new Proxy(s, { apply: (_t, self: unknown, args: unknown[]) => hook(s, self, args[0] as T) }), s);
    }
    defineLike(holder, key, change);
    return native;
}

/**
 * Wraps the constructor `key` of `realm` (e.g. "WebSocket"). `construct`
 * receives the native and the arguments and returns the instance; calls
 * without `new` go to the native (which throws as it would).
 */
export function wrapConstructor<C extends abstract new (...args: never[]) => object>(
    realm: object,
    key: string,
    construct: (native: C, args: unknown[], newTarget: unknown) => object,
): C | undefined {
    const holder = holderOf(realm, key);
    if (!holder) return undefined;
    const native = Object.getOwnPropertyDescriptor(holder, key)?.value as C | undefined;
    if (typeof native !== "function") return undefined;
    const wrapper: C = new Proxy(native, {
        construct(target, args: unknown[], newTarget: unknown): object {
            // A subclass of the wrapper (class X extends WebSocket) must still
            // get an instance of its own class.
            return construct(target, args, newTarget === wrapper ? target : newTarget);
        },
    });
    maskAs(wrapper, native);
    const proto = (native as unknown as { prototype?: object }).prototype;
    if (proto && Object.getOwnPropertyDescriptor(proto, "constructor")?.value === native) {
        defineLike(proto, "constructor", { value: wrapper });
    }
    defineLike(holder, key, { value: wrapper });
    return native;
}
