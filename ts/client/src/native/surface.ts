// The native surface (REQUIREMENTS.md, "the whole native surface"): the one
// way any patch replaces a member of a native browser class.
//
// Page code must see a native where cyrano put a wrapper. Everything a
// script can ask of a function or property is kept as the native's:
//
//   * a method is a function standing in for the native (standIn) — `name`,
//     `length`, the absence of `prototype`, non-constructability, and the
//     "Illegal invocation" TypeError on a wrong receiver are the native's;
//   * a constructor is a stand-in too, with the native's `prototype`
//     object and static members and `prototype.constructor` pointing back
//     at it, so `instanceof`, statics and `new.target` behave;
//   * an accessor keeps the native descriptor's shape — same object, same
//     enumerable/configurable, a setter where the native has one — with
//     stand-in getter/setter (`name` "get URL" etc. kept);
//   * Function.prototype.toString answers for every wrapper what it
//     answers for the native it replaced ("function fetch() { [native
//     code] }"), and for itself.
//
// This is heuristic, not a guarantee (owner, 2026-11-17): page code can
// capture natives before cyrano runs, or probe in ways no wrapper hides.

import { SafeWeakMap, SafeWeakSet, nO, nOP, nR, ncall } from "./intrinsics";
import { original } from "../js/marks";
import { PADDED_METHODS } from "./padded";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => unknown;

/** wrapper → the native it stands for (what toString reports). */
const masks = new SafeWeakMap<object, object>();

const installedRealms = new SafeWeakSet<object>();

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
    const masked = standIn(nativeToString, {
        apply(target, thisArg: unknown, args: unknown[]) {
            const shown = typeof thisArg === "function" || typeof thisArg === "object"
                ? masks.get(thisArg as object) ?? thisArg
                : thisArg;
            // A function from a rewritten script shows the source the page
            // wrote: the rewriters' edits are taken out again (js/marks.ts).
            const text = nR.apply(target, shown, args) as unknown;
            return typeof text === "string" ? original(text) : text;
        },
    });
    masks.set(masked, nativeToString);
    defineLike(FnProto, "toString", { value: masked });
}

/**
 * A function to stand in for the native function `native`: `handler.apply`
 * runs for a call, `handler.construct` for `new` (without it the stand-in
 * is no constructor, as a native method is none).
 *
 * It is a function of its own, not a Proxy of the native. A Proxy can be
 * told from the function it wraps without calling it, and challenge
 * scripts do (Cloudflare's runs both of these on every native it checks):
 *   * `Object.setPrototypeOf(f, f)` — "Cyclic __proto__ value" for any
 *     ordinary object — succeeds on a Proxy;
 *   * V8 names a stack frame's receiver by the `constructor` it finds on
 *     the receiver's prototype chain and does not look into a Proxy:
 *     `Object.create(f).toString()` fails "at Function.toString" for a
 *     function, "at Object.toString" for a Proxy of one.
 * What a script can read of the stand-in is made the native's: name,
 * length, [[Prototype]], no own `prototype` (a method) or the native's own
 * (a constructor, with its static members), no own `arguments`/`caller`
 * (strict, as built-ins), and its source through Function.prototype.toString
 * (maskAs). Known difference: reading `.caller` or `.arguments` throws on a
 * strict function and yields null on a built-in.
 */
export function standIn<F extends object>(
    native: F,
    handler: {
        apply?: (target: F, self: unknown, args: unknown[]) => unknown;
        construct?: (target: F, args: unknown[], newTarget: unknown) => object;
    },
): F {
    const call = handler.apply;
    const construct = handler.construct;
    let wrapper: object;
    // Defined under the native's name: the name V8 itself knows the
    // function by (in stack frames) is then the native's too.
    const name = String((native as { name?: unknown }).name ?? "");
    if (construct) {
        wrapper = ({
            [name]: function (this: unknown, ...args: unknown[]): unknown {
                if (new.target === undefined) {
                    // Called as a function: a DOM constructor refuses in its own words.
                    return call ? call(native, this, args) : nR.apply(native as unknown as AnyFn, this, args);
                }
                return construct(native, args, new.target);
            },
        })[name] as object;
        // The native's static members (WebSocket.OPEN, URL.createObjectURL …).
        for (const key of nR.ownKeys(native)) {
            if (key === "length" || key === "name" || key === "prototype" || key === "arguments" || key === "caller") continue;
            const d = nO.getOwnPropertyDescriptor(native, key);
            if (d) { try { nO.defineProperty(wrapper, key, d); } catch { /* stays absent */ } }
        }
        const proto = nO.getOwnPropertyDescriptor(native, "prototype");
        if (proto) nO.defineProperty(wrapper, "prototype", proto);
    } else if (ncall(nOP.hasOwnProperty, PADDED_METHODS, name)) {
        // One V8 prints as a native, in its own messages too (padded.ts).
        wrapper = PADDED_METHODS[name]!((self, args) => (call ? call(native, self, args) : nR.apply(native as unknown as AnyFn, self, args)));
    } else {
        // A method definition: no `prototype`, not a constructor.
        wrapper = ({
            [name](this: unknown, ...args: unknown[]): unknown {
                return call ? call(native, this, args) : nR.apply(native as unknown as AnyFn, this, args);
            },
        })[name] as object;
    }
    for (const key of ["length", "name"] as const) {
        const d = nO.getOwnPropertyDescriptor(native, key);
        if (d) nO.defineProperty(wrapper, key, d); else delete (wrapper as Record<string, unknown>)[key];
    }
    nO.setPrototypeOf(wrapper, nO.getPrototypeOf(native) as object | null);
    return wrapper as F;
}

/** Records that `wrapper` must read as `native` (for wrappers built elsewhere). */
export function maskAs<T extends object>(wrapper: T, native: object): T {
    masks.set(wrapper, masks.get(native) ?? native);
    return wrapper;
}

/** Where `key` is defined: `owner` or the nearest prototype that has it. */
function holderOf(owner: object, key: PropertyKey): object | null {
    for (let o: object | null = owner; o; o = nO.getPrototypeOf(o) as object | null) {
        if (ncall(nOP.hasOwnProperty, o, key)) return o;
    }
    return null;
}

/** Redefines `key` on `holder`, keeping the native descriptor's attributes. */
function defineLike(holder: object, key: PropertyKey, change: PropertyDescriptor): void {
    const native = nO.getOwnPropertyDescriptor(holder, key);
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
    nO.defineProperty(holder, key, next);
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
    const native = nO.getOwnPropertyDescriptor(holder, key)?.value as F | undefined;
    if (typeof native !== "function") return undefined;
    const wrapper = standIn(native, {
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
    const native = nO.getOwnPropertyDescriptor(holder, key);
    if (!native || (!native.get && !native.set)) return undefined;
    const change: PropertyDescriptor = {};
    if (hooks.get && native.get) {
        const g = native.get as (this: unknown) => T;
        const hook = hooks.get;
        change.get = maskAs(standIn(g, { apply: (_t, self: unknown) => hook(g, self) }), g);
    }
    if (hooks.set && native.set) {
        const s = native.set as (this: unknown, v: T) => void;
        const hook = hooks.set;
        change.set = maskAs(standIn(s, { apply: (_t, self: unknown, args: unknown[]) => hook(s, self, args[0] as T) }), s);
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
    const native = nO.getOwnPropertyDescriptor(holder, key)?.value as C | undefined;
    if (typeof native !== "function") return undefined;
    const wrapper: C = standIn(native, {
        construct(target, args: unknown[], newTarget: unknown): object {
            // A subclass of the wrapper (class X extends WebSocket) must still
            // get an instance of its own class.
            return construct(target, args, newTarget === wrapper ? target : newTarget);
        },
    });
    maskAs(wrapper, native);
    const proto = (native as unknown as { prototype?: object }).prototype;
    if (proto && nO.getOwnPropertyDescriptor(proto, "constructor")?.value === native) {
        defineLike(proto, "constructor", { value: wrapper });
    }
    defineLike(holder, key, { value: wrapper });
    return native;
}
