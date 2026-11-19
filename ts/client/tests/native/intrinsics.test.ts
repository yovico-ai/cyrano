// @vitest-environment node

// The built-ins the runtime calls are saved when the bundle loads; page code
// that replaces WeakMap.prototype.get, Function.prototype.call, … afterwards
// (anti-tamper scripts do) sees none of the runtime's calls, and the
// runtime keeps working.

import { afterEach, describe, expect, it } from "vitest";
import { SafeMap, SafeSet, SafeWeakMap, SafeWeakSet, napply, nbind, ncall } from "../../src/native/intrinsics";

// Replaced built-ins, put back after each test.
const replaced: Array<[object, PropertyKey, PropertyDescriptor]> = [];
function replace(owner: object, key: PropertyKey, value: unknown): void {
    replaced.push([owner, key, Object.getOwnPropertyDescriptor(owner, key)!]);
    Object.defineProperty(owner, key, { value, writable: true, configurable: true });
}
function restore(): void {
    while (replaced.length) {
        const [o, k, d] = replaced.pop()!;
        Object.defineProperty(o, k, d);
    }
}
afterEach(restore);

// Runs `body` with the hooks in place and restores the natives before
// returning: the test framework itself uses the replaced built-ins, so
// every assertion is made afterwards, on what `body` returned.
function hooked<T>(install: (hook: (name: string) => () => never) => void, body: () => T): { result: T; calls: string[] } {
    const calls: string[] = [];
    const hook = (name: string) => function (this: unknown): never { calls.push(name); throw new Error(`hooked ${name}`); };
    try {
        install(hook);
        return { result: body(), calls: calls.slice() };
    } finally {
        restore();
    }
}

describe("Safe collections after the page replaces the natives", () => {
    it("SafeWeakMap / SafeWeakSet: get, set, has, delete, add", () => {
        const { result, calls } = hooked((hook) => {
            for (const k of ["get", "set", "has", "delete"]) replace(WeakMap.prototype, k, hook(`WeakMap.${k}`));
            for (const k of ["add", "has", "delete"]) replace(WeakSet.prototype, k, hook(`WeakSet.${k}`));
        }, () => {
            const key = {};
            const m = new SafeWeakMap<object, number>();
            const out: unknown[] = [];
            out.push(m.set(key, 1) === m, m.get(key), m.has(key), m.delete(key), m.has(key));
            const s = new SafeWeakSet<object>();
            out.push(s.add(key) === s, s.has(key), s.delete(key), s.has(key));
            return out;
        });
        expect(calls).toEqual([]);
        expect(result).toEqual([true, 1, true, true, false, true, true, true, false]);
    });

    it("SafeMap / SafeSet: methods, size and iteration", () => {
        const { result, calls } = hooked((hook) => {
            for (const k of ["get", "set", "has", "delete", "clear", "forEach", "keys", "values", "entries"]) replace(Map.prototype, k, hook(`Map.${k}`));
            for (const k of ["add", "has", "delete", "clear", "forEach", "values"]) replace(Set.prototype, k, hook(`Set.${k}`));
            replace(Map.prototype, Symbol.iterator, hook("Map.@@iterator"));
            replace(Set.prototype, Symbol.iterator, hook("Set.@@iterator"));
            replace(Map.prototype, "size", undefined);
            Object.defineProperty(Map.prototype, "size", { get: hook("Map.size"), configurable: true });
            replace(Set.prototype, "size", undefined);
            Object.defineProperty(Set.prototype, "size", { get: hook("Set.size"), configurable: true });
        }, () => {
            const out: Record<string, unknown> = {};
            const m = new SafeMap<string, number>();
            m.set("a", 1).set("b", 2);
            out.get = m.get("a");
            out.has = m.has("b");
            out.size = m.size;
            out.entries = [...m];
            out.keys = [...m.keys()];
            const seen: string[] = [];
            m.forEach((_v, k) => seen.push(k));
            out.forEach = seen;
            m.delete("a");
            out.afterDelete = m.size;
            m.clear();
            out.afterClear = m.size;
            const s = new SafeSet<string>(["x"]);
            s.add("y");
            out.setHas = s.has("x");
            out.setSize = s.size;
            out.setItems = [...s];
            s.delete("x");
            out.setValues = [...s.values()];
            return out;
        });
        expect(calls).toEqual([]);
        expect(result).toEqual({
            get: 1, has: true, size: 2, entries: [["a", 1], ["b", 2]], keys: ["a", "b"], forEach: ["a", "b"],
            afterDelete: 1, afterClear: 0, setHas: true, setSize: 2, setItems: ["x", "y"], setValues: ["y"],
        });
    });

    it("the constructor fills from an iterable through the pinned set / add", () => {
        const { result, calls } = hooked((hook) => {
            replace(Map.prototype, "set", hook("Map.set"));
            replace(Set.prototype, "add", hook("Set.add"));
        }, () => [new SafeMap([["k", 1]]).get("k"), new SafeSet([1, 2]).has(2)]);
        expect(calls).toEqual([]);
        expect(result).toEqual([1, true]);
    });
});

describe("ncall / napply / nbind", () => {
    function f(this: unknown, ...args: unknown[]): { self: unknown; args: unknown[] } {
        return { self: this, args };
    }

    it("ncall is f.call", () => {
        const self = {};
        expect(ncall(f, self, 1, 2)).toEqual(f.call(self, 1, 2));
        expect(ncall(f, self).args).toEqual([]);
        expect(ncall(f, self, 1).self).toBe(self);
    });

    it("napply is f.apply, with undefined / null args", () => {
        const self = {};
        expect(napply(f, self, [1, 2])).toEqual(f.apply(self, [1, 2]));
        expect(napply(f, self).args).toEqual(f.apply(self).args);
        expect(napply(f, self, undefined).args).toEqual([]);
        expect(napply(f, self, null).args).toEqual(f.apply(self, null as unknown as []).args);
    });

    it("napply takes an array-like, as apply does: arguments, {length}", () => {
        const self = {};
        function viaArguments(..._a: unknown[]): unknown {
            // eslint-disable-next-line prefer-rest-params
            return napply(f, self, arguments).args;
        }
        expect(viaArguments(1, "two", undefined)).toEqual([1, "two", undefined]);
        expect(napply(f, self, { length: 2, 0: "a", 1: "b" }).args).toEqual(["a", "b"]);
        expect(napply(f, self, { length: 2, 0: "a" }).args).toEqual(["a", undefined]);
    });

    it("napply throws as apply does for a non-object args", () => {
        expect(() => napply(f, {}, 5 as unknown as [])).toThrow(TypeError);
        expect(() => f.apply({}, 5 as unknown as [])).toThrow(TypeError);
    });

    it("nbind is f.bind: this, leading arguments, name, length, construct", () => {
        const self = {};
        const bound = nbind(f, self, 1);
        expect(bound(2)).toEqual({ self, args: [1, 2] });
        const native = f.bind(self, 1);
        expect(bound.name).toBe(native.name);
        expect(bound.length).toBe(native.length);
        class C { constructor(public a: number, public b: number) {} }
        const BoundC = nbind(C as unknown as (...a: unknown[]) => unknown, null, 7) as unknown as new (b: number) => C;
        const c = new BoundC(8);
        expect(c).toBeInstanceOf(C);
        expect([c.a, c.b]).toEqual([7, 8]);
    });

    it("none of them goes through Function.prototype.call / apply / bind or Reflect.apply", () => {
        const self = {};
        const { result, calls } = hooked((hook) => {
            replace(Function.prototype, "call", hook("call"));
            replace(Function.prototype, "apply", hook("apply"));
            replace(Function.prototype, "bind", hook("bind"));
            replace(Reflect, "apply", hook("Reflect.apply"));
        }, () => [ncall(f, self, 1), napply(f, self, [1]), nbind(f, self, 1)()]);
        expect(calls).toEqual([]);
        expect(result).toEqual([{ self, args: [1] }, { self, args: [1] }, { self, args: [1] }]);
        expect(result.every((r) => r.self === self)).toBe(true);
    });
});
