// A popup's first document severed from its opener where the browser,
// seeing the proxy's origin for both, would not sever it (spec/Coop.agda
// emulated; coop-vs-chromium): its opener null, its name cleared — as a
// browsing context group switch leaves them (the accessor kept: the
// wrapped getter answers) — and the opener's handle
// reading closed (native/cross-origin.ts).

import { nO, ncall } from "../native/intrinsics";
import { coopOpened, coopSevered } from "../native/cross-origin";
import { coopEmulated, coopOf, type Coop } from "../url/coop";
import type { ClientConfig } from "../config";

export function applyCoop(targetWindow: Window, config: ClientConfig, origin: string, proxyOrigin: string): void {
    let rec: { coop: string; origin: string } | undefined;
    try { rec = coopOpened().get(targetWindow); } catch { rec = undefined; }
    if (!rec) return;
    coopOpened().delete(targetWindow); // the first document only
    const mine = coopOf(config.coop ?? null, true, config.coep === true);
    if (!coopEmulated(rec.coop as Coop, rec.origin, mine, origin, proxyOrigin)) return;
    coopSevered().add(targetWindow); // its opener reads null (patches/cross-origin-windows.ts), the opener's handle closed

    try {
        const d = nO.getOwnPropertyDescriptor(nO.getPrototypeOf(targetWindow) as object, "name") ?? nO.getOwnPropertyDescriptor(targetWindow, "name");
        if (d?.set) ncall(d.set, targetWindow, "");
    } catch { /* as it is */ }
}
