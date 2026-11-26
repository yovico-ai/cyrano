// A popup's document severed from its opener where the browser,
// seeing the proxy's origin for both, would not sever it (spec/Coop.agda
// emulated; coop-vs-chromium): its opener null, its name cleared — as a
// browsing context group switch leaves them (the accessor kept: the
// wrapped getter answers) — and the opener's handle
// reading closed (native/cross-origin.ts) — at its first document, and at
// a later one that does not match the document before it. Limit: an
// opener that holds the popup as a same-origin handle (it opened on the
// opener's own origin) still reads it live after such a later switch —
// `closed` is the popup's own accessor, which cannot tell the opener
// calling from the popup reading itself.

import { nO, ncall } from "../native/intrinsics";
import { coopCurrent, coopOpened, coopSevered } from "../native/cross-origin";
import { coopEmulatedAt, coopOf, type Coop } from "../url/coop";
import type { ClientConfig } from "../config";

export function applyCoop(targetWindow: Window, config: ClientConfig, origin: string, proxyOrigin: string): void {
    const mine = coopOf(config.coop ?? null, true, config.coep === true);
    // A popup's first document is judged against its initial about:blank
    // (its opener's policy and origin, recorded at window.open); each later
    // one against the document before it (kept in the page tree's registry,
    // which the opener holds across the popup's navigations).
    let rec: { coop: string; origin: string } | undefined;
    let initial = false;
    try {
        rec = coopOpened().get(targetWindow);
        if (rec) { initial = true; coopOpened().delete(targetWindow); } else rec = coopCurrent().get(targetWindow);
        coopCurrent().set(targetWindow, { coop: mine, origin });
    } catch { rec = undefined; }
    if (!rec) return;
    if (!coopEmulatedAt(initial, rec.coop as Coop, rec.origin, mine, origin, proxyOrigin)) return;
    coopSevered().add(targetWindow); // its opener reads null (patches/cross-origin-windows.ts), the opener's handle closed

    try {
        const d = nO.getOwnPropertyDescriptor(nO.getPrototypeOf(targetWindow) as object, "name") ?? nO.getOwnPropertyDescriptor(targetWindow, "name");
        if (d?.set) ncall(d.set, targetWindow, "");
    } catch { /* as it is */ }
}
