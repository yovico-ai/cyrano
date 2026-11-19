// The Navigation API, as page code sees it natively.
//
//   * URLs read are the original ones: NavigationHistoryEntry.url
//     (navigation.currentEntry, entries(), a transition's `from`) and
//     NavigationDestination.url (a navigate event's destination) — the
//     browser's are the proxy's;
//   * navigation.navigate(url) goes through URL containment, resolved
//     against the page's original URL;
//   * after a same-document navigation (a navigate event the page
//     intercepted) the page's base URL follows the real location, as for
//     history.pushState.
//
// Shopify's exit-intent script reads the destination URL of every
// navigation: with the proxy's, each internal link looked external and was
// sent through /url?q=, nested deeper each time.

import { wrapAccessor, wrapMethod } from "../native/surface";
import { nR } from "../native/intrinsics";

export function patchNavigation(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
    unwrapOne: (proxied: string) => string,
    setBaseUrl: (href: string) => void,
): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    const original = (href: unknown): unknown => (typeof href === "string" ? unwrapOne(href) : href);
    for (const name of ["NavigationHistoryEntry", "NavigationDestination"]) {
        const proto = g[name]?.prototype;
        if (proto) wrapAccessor<string | null>(proto, "url", { get: (native, self) => original(nR.apply(native, self, [])) as string | null });
    }
    const Nav = g["Navigation"]?.prototype;
    if (!Nav) return;
    wrapMethod<(...a: unknown[]) => unknown>(Nav, "navigate", (native, self, args) => {
        const next = args.slice();
        if (next.length > 0 && next[0] !== undefined) next[0] = rewriteOne(String(next[0]));
        return nR.apply(native, self, next);
    });
    const realLocation = targetWindow.location;
    const navigation = (targetWindow as unknown as { navigation?: EventTarget }).navigation;
    navigation?.addEventListener("currententrychange", () => {
        const href = unwrapOne(realLocation.href);
        if (href !== realLocation.href) setBaseUrl(href);
    });
}
