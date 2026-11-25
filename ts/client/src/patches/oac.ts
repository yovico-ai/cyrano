// window.originAgentCluster by the page's original origin (spec/Oac.agda;
// origin-agent-cluster-vs-chromium). Within a browsing context group the
// first document of an origin decides for later ones; through the proxy
// every site is the proxy's origin, so the first proxied document decided
// for all (a popup of another site read its opener's ?0). The group's
// documents share a table by original origin (sharedData reaches the
// opener and the frames' relatives).

import { SafeMap } from "../native/intrinsics";
import { sharedData } from "../native/shared";
import { wrapAccessor } from "../native/surface";
import { nO } from "../native/intrinsics";

/** spec Oac.reads */
export function oacReads(recorded: boolean | undefined, secure: boolean, header: string | undefined): boolean {
    if (recorded !== undefined) return recorded;
    return secure && header !== "?0";
}

export function applyOac(targetWindow: Window, origin: string, secure: boolean, header: string | undefined): void {
    const table = sharedData("oacByOrigin", () => new SafeMap<string, boolean>());
    const value = oacReads(table.get(origin), secure, header);
    if (!table.has(origin)) table.set(origin, value);
    for (let o: object | null = targetWindow; o; o = nO.getPrototypeOf(o) as object | null) {
        const d = nO.getOwnPropertyDescriptor(o, "originAgentCluster");
        if (d?.get) { wrapAccessor<boolean>(o, "originAgentCluster", { get: () => value }); return; }
    }
}
