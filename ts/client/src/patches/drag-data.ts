// The drag data store, as the page reads it (round J): the browser fills
// it from the element dragged — a link's or image's stored URL, its markup
// — so through the proxy `getData("text/uri-list" | "text/plain" |
// "text/html")` held proxified URLs. Directly they are the resolved
// original URLs, which unwrapping gives. Data the page put there itself
// names its own URLs, never the proxy's, and reads as set.

import { nO, nR, ncall } from "../native/intrinsics";
import { wrapMethod } from "../native/surface";

export function patchDragData(targetWindow: Window, readBack: (t: string) => string): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    const DT = g["DataTransfer"]?.prototype;
    if (DT && typeof nO.getOwnPropertyDescriptor(DT, "getData")?.value === "function") {
        wrapMethod<(...a: unknown[]) => unknown>(DT, "getData", (native, self, args) => {
            const v = nR.apply(native, self, args);
            return typeof v === "string" ? readBack(v) : v;
        });
    }
    const DI = g["DataTransferItem"]?.prototype;
    if (DI && typeof nO.getOwnPropertyDescriptor(DI, "getAsString")?.value === "function") {
        wrapMethod<(...a: unknown[]) => unknown>(DI, "getAsString", (native, self, args) => {
            const cb = args[0];
            if (typeof cb !== "function") return nR.apply(native, self, args);
            return ncall(native as (...a: unknown[]) => unknown, self, function (this: unknown, s: unknown): unknown {
                return nR.apply(cb as (...a: unknown[]) => unknown, this, [typeof s === "string" ? readBack(s) : s]);
            });
        });
    }
}
