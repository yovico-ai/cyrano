// Cross-Origin-Opener-Policy (spec/Coop.agda; coop-vs-chromium). A popup
// whose document's policy does not match its opener's is put in a group
// of its own — the opener's handle reads closed, the popup's opener is
// null and its name cleared. The match is by value and origin, and
// through the proxy every document has the proxy's origin: two sites
// that both send `same-origin` matched (round K). The browser severs
// where the values differ; the runtime severs where only the original
// origins do (`emulated`).

export type Coop = "unsafe-none" | "same-origin-allow-popups" | "same-origin" | "same-origin-plus-coep" | "noopener-allow-popups";

/**
 * spec Coop.coopOf: the header's value (null: none), the document a secure
 * context, its embedder policy require-corp. The header is read by the
 * server (a structured item: Go urlrewrite.CoopOf) and given as its token.
 */
export function coopOf(token: string | null, secure: boolean, corp: boolean): Coop {
    if (token === null || !secure) return "unsafe-none";
    if (token === "same-origin") return corp ? "same-origin-plus-coep" : "same-origin";
    if (token === "same-origin-allow-popups" || token === "noopener-allow-popups") return token;
    return "unsafe-none";
}

/** spec Coop.matches */
export function coopMatches(a: Coop, oa: string, b: Coop, ob: string): boolean {
    if (a === "unsafe-none" && b === "unsafe-none") return true;
    return a === b && oa === ob;
}

/** spec Coop.switchesAt: a top-level navigation from a document of policy `a`, origin `oa` (`initial`: a popup's initial about:blank) needs a group of its own. */
export function coopSwitchesAt(initial: boolean, a: Coop, oa: string, b: Coop, ob: string): boolean {
    return !coopMatches(a, oa, b, ob) && !(initial && a === "same-origin-allow-popups" && b === "unsafe-none");
}

/** spec Coop.switches: a popup's first navigation from its initial about:blank (policy `a`, origin `oa`) needs a group of its own. */
export function coopSwitches(a: Coop, oa: string, b: Coop, ob: string): boolean {
    return coopSwitchesAt(true, a, oa, b, ob);
}

/** spec Coop.emulatedAt: a switch by the original origins the browser, seeing the proxy's for both, does not make. */
export function coopEmulatedAt(initial: boolean, a: Coop, oa: string, b: Coop, ob: string, proxy: string): boolean {
    return coopSwitchesAt(initial, a, oa, b, ob) && !coopSwitchesAt(initial, a, proxy, b, proxy);
}

/** spec Coop.emulated */
export function coopEmulated(a: Coop, oa: string, b: Coop, ob: string, proxy: string): boolean {
    return coopEmulatedAt(true, a, oa, b, ob, proxy);
}
