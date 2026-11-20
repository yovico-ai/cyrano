// `location` reached through reflection, as through a name.
//
// Rewritten code reads `location`, `X.location` and `X[k]` through the
// runtime's view of the page's location (R1, R3, R5). A window's and a
// document's `location` is an unforgeable accessor — it cannot be
// replaced — so its getter, handed out by reflection, returned the
// native Location: `Reflect.get(window, "location")`,
// `Object.getOwnPropertyDescriptor(window, "location").get.call(window)`,
// `__lookupGetter__`, the same of a document. A page could tell the two
// apart (`===`), and read the proxy's URL off the native; PerimeterX's
// sensor on Zillow had its API calls refused through the proxy
// (2026-11-20). The getter and setter reflection hands out for them are
// stand-ins for the natives (one each, so identity holds) that answer
// with the view; Reflect.set navigates through it.

import { SafeWeakMap, nR } from "../native/intrinsics";
import { maskAs, standIn, wrapMethod } from "../native/surface";

type AnyFn = (...a: unknown[]) => unknown;

export function patchLocationReflection(
    targetWindow: Window,
    holder: (obj: unknown) => { location: unknown },
    isWindowLike: (obj: unknown) => boolean,
): void {
    const g = targetWindow as unknown as { Object: ObjectConstructor; Reflect: typeof Reflect };
    const O = g.Object;
    const R = g.Reflect;
    if (!O || !R) return;
    const fakes = new SafeWeakMap<object, AnyFn>();
    const fake = (native: AnyFn, kind: "get" | "set"): AnyFn => {
        let f = fakes.get(native);
        if (!f) {
            f = maskAs(standIn(native, {
                apply: (t, self, args) => {
                    if (!isWindowLike(self)) return nR.apply(t, self, args);
                    if (kind === "get") return holder(self).location;
                    holder(self).location = args[0];
                    return undefined;
                },
            }), native);
            fakes.set(native, f);
        }
        return f;
    };
    const fixed = (o: unknown, key: unknown, d: PropertyDescriptor | undefined): PropertyDescriptor | undefined => {
        if (key !== "location" || !d || !isWindowLike(o)) return d;
        const out: PropertyDescriptor = { ...d };
        if (d.get) out.get = fake(d.get as AnyFn, "get");
        if (d.set) out.set = fake(d.set as AnyFn, "set");
        return out;
    };
    for (const holderObj of [O, R] as const) {
        wrapMethod<AnyFn>(holderObj, "getOwnPropertyDescriptor", (native, self, args) =>
            fixed(args[0], args[1], nR.apply(native, self, args) as PropertyDescriptor | undefined));
    }
    wrapMethod<AnyFn>(O, "getOwnPropertyDescriptors", (native, self, args) => {
        const out = nR.apply(native, self, args) as Record<string, PropertyDescriptor> | undefined;
        if (out && out["location"]) out["location"] = fixed(args[0], "location", out["location"])!;
        return out;
    });
    // Reflect.get / set of a window's or document's location, on itself.
    wrapMethod<AnyFn>(R, "get", (native, self, args) =>
        args[1] === "location" && isWindowLike(args[0]) && (args.length < 3 || args[2] === args[0])
            ? holder(args[0]).location : nR.apply(native, self, args));
    wrapMethod<AnyFn>(R, "set", (native, self, args) => {
        if (args[1] === "location" && isWindowLike(args[0]) && (args.length < 4 || args[3] === args[0])) {
            holder(args[0]).location = args[2];
            return true;
        }
        return nR.apply(native, self, args);
    });
    // The legacy accessor lookups.
    const OP = O.prototype as unknown as Record<string, unknown>;
    for (const [name, kind] of [["__lookupGetter__", "get"], ["__lookupSetter__", "set"]] as const) {
        if (typeof OP[name] !== "function") continue;
        wrapMethod<AnyFn>(OP, name, (native, self, args) => {
            const f = nR.apply(native, self, args) as AnyFn | undefined;
            return f && args[0] === "location" && isWindowLike(self) ? fake(f, kind) : f;
        });
    }
}
