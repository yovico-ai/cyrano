// What an attribute held before, as the page wrote it (round J). Two
// browser surfaces hand page code the values an element held, which for a
// URL or style attribute the runtime rewrote are proxified:
//   * `MutationRecord#oldValue` (attributeOldValue / characterDataOldValue
//     observers: session-replay recorders, frameworks);
//   * a custom element's `attributeChangedCallback(name, oldValue,
//     newValue)` (customized built-ins: `is=`).
// Each value is mapped back through the runtime's record of what it wrote
// for that attribute (originals.ts writtenFormOf: the value now and a few
// before); anything else that names a proxified URL is unwrapped (a URL the
// page wrote relative then reads absolute: a gap). Only for values the
// browser gives: a page's own MutationRecord cannot be made.

import { nO, nR, ncall } from "../native/intrinsics";
import { wrapAccessor, wrapMethod } from "../native/surface";
import { writtenFormOf } from "../native/originals";

export function patchAttrHistory(targetWindow: Window, readBack: (t: string) => string): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    const back = (el: unknown, name: string | null, held: unknown): unknown => {
        if (typeof held !== "string") return held;
        if (name !== null) {
            const w = writtenFormOf(el, name, held);
            if (w !== undefined) return w;
        }
        return readBack(held);
    };
    const MR = g["MutationRecord"]?.prototype;
    if (MR) {
        const target = nO.getOwnPropertyDescriptor(MR, "target")?.get;
        const attr = nO.getOwnPropertyDescriptor(MR, "attributeName")?.get;
        if (target && attr && nO.getOwnPropertyDescriptor(MR, "oldValue")?.get) {
            wrapAccessor<unknown>(MR, "oldValue", {
                get: (gt, self) => back(ncall(target, self), ncall(attr, self) as string | null, ncall(gt, self)),
            });
        }
    }
    // customElements.define reads the class's callbacks once, as it
    // defines it: it is shown one that maps the values, then the class's
    // own is put back (the page's prototype reads as it wrote it).
    const CER = g["CustomElementRegistry"]?.prototype;
    if (CER && typeof nO.getOwnPropertyDescriptor(CER, "define")?.value === "function") {
        wrapMethod<(...a: unknown[]) => unknown>(CER, "define", (native, self, args) => {
            const ctor = args[1] as { prototype?: object } | undefined;
            const proto = typeof ctor === "function" ? (ctor as { prototype?: object }).prototype : undefined;
            const d = proto ? nO.getOwnPropertyDescriptor(proto, "attributeChangedCallback") : undefined;
            const cb = d && typeof d.value === "function" ? d.value as (this: unknown, ...a: unknown[]) => unknown : undefined;
            if (!proto || !d || !cb || !d.configurable) return nR.apply(native, self, args);
            const shown = function (this: unknown, name: unknown, oldValue: unknown, newValue: unknown, ...rest: unknown[]): unknown {
                const n = typeof name === "string" ? name : null;
                return nR.apply(cb, this, [name, back(this, n, oldValue), back(this, n, newValue), ...rest]);
            };
            nO.defineProperty(proto, "attributeChangedCallback", { ...d, value: shown });
            try {
                return nR.apply(native, self, args);
            } finally {
                nO.defineProperty(proto, "attributeChangedCallback", d);
            }
        });
    }
}
