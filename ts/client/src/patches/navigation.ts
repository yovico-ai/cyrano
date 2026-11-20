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
//     history.pushState;
//   * the navigation net (spec/Route.agda netDestination): a navigation
//     this document starts for an http(s) URL off the proxy's origin — a
//     location assignment the rules did not see (`window[k] = url`, a
//     setTimeout string), a meta refresh, an unrewritten link or form — is
//     cancelled before it leaves and made to the proxified URL instead.
//     The listener is the first on `navigation`, added before any page
//     script runs; a page's own navigate listeners see only the
//     navigation that replaces it.
//
// Shopify's exit-intent script reads the destination URL of every
// navigation: with the proxy's, each internal link looked external and was
// sent through /url?q=, nested deeper each time.

import { wrapAccessor, wrapMethod } from "../native/surface";
import { nO, nR, ncall } from "../native/intrinsics";

/**
 * spec netDestination: where a navigation to `dest` goes instead, or null
 * when it is left alone (not http(s), on the proxy's origin, or nothing
 * the rewrite changes).
 */
export function netDestination(dest: string, proxyOrigin: string, rewriteOne: (url: string) => string): string | null {
    let u: URL;
    try { u = new URL(dest); } catch { return null; }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.origin === proxyOrigin) return null;
    const to = rewriteOne(dest);
    return to === dest ? null : to;
}

export function patchNavigation(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
    unwrapOne: (proxied: string) => string,
    setBaseUrl: (href: string) => void,
    proxyOrigin?: string,
): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined>;
    // The net's natives, as they are before the wrapping below and before any page script.
    const getter = (proto: object | undefined, k: string): ((this: unknown) => unknown) | undefined =>
        (proto ? nO.getOwnPropertyDescriptor(proto, k)?.get : undefined) as ((this: unknown) => unknown) | undefined;
    const NE = g["NavigateEvent"]?.prototype, EV = g["Event"]?.prototype;
    const net = {
        destination: getter(NE, "destination"), type: getter(NE, "navigationType"), hash: getter(NE, "hashChange"),
        download: getter(NE, "downloadRequest"), form: getter(NE, "formData"), source: getter(NE, "sourceElement"),
        cancelable: getter(EV, "cancelable"), trusted: undefined as undefined,
        url: getter(g["NavigationDestination"]?.prototype, "url"),
        prevent: (EV as Record<string, unknown> | undefined)?.["preventDefault"] as ((this: unknown) => void) | undefined,
        stop: (EV as Record<string, unknown> | undefined)?.["stopImmediatePropagation"] as ((this: unknown) => void) | undefined,
        listen: (g["EventTarget"]?.prototype as Record<string, unknown> | undefined)?.["addEventListener"] as ((this: unknown, ...a: unknown[]) => void) | undefined,
    };
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
    // The net: first in line (added now), for navigations this document starts.
    const { destination, url, type, cancelable, prevent, stop, listen } = net;
    if (navigation && proxyOrigin && destination && url && type && cancelable && prevent && stop && listen) {
        const assign = realLocation.assign, replace = realLocation.replace;
        const FormP = g["HTMLFormElement"]?.prototype as Record<string, unknown> | undefined;
        const submit = FormP?.["submit"] as ((this: unknown) => void) | undefined;
        const formOf = getter(g["HTMLButtonElement"]?.prototype, "form");
        const setAttr = (g["Element"]?.prototype as Record<string, unknown> | undefined)?.["setAttribute"] as ((this: unknown, n: string, v: string) => void) | undefined;
        const getAttr = (g["Element"]?.prototype as Record<string, unknown> | undefined)?.["getAttribute"] as ((this: unknown, n: string) => string | null) | undefined;
        const removeAttr = (g["Element"]?.prototype as Record<string, unknown> | undefined)?.["removeAttribute"] as ((this: unknown, n: string) => void) | undefined;
        ncall(listen as never, navigation, "navigate", (e: Event) => {
            try {
                if (!ncall(cancelable, e) || (net.hash && ncall(net.hash, e)) || (net.download && ncall(net.download, e) != null)) return;
                const to = netDestination(String(ncall(url, ncall(destination, e))), proxyOrigin, rewriteOne);
                if (to === null) return;
                ncall(prevent, e);
                ncall(stop, e);
                // A form's submission: sent again, to the proxified action
                // (its method and body are the form's).
                const data = net.form ? ncall(net.form, e) : null;
                const src = net.source ? (ncall(net.source, e) as Element | null) : null;
                if (data && src && submit && setAttr && getAttr && removeAttr) {
                    let form: Element | null = src;
                    if (!(form instanceof (targetWindow as unknown as { HTMLFormElement: typeof HTMLFormElement }).HTMLFormElement)) {
                        try { form = formOf ? (ncall(formOf, src) as Element | null) : null; } catch { form = null; }
                    }
                    if (form) {
                        const was = ncall(getAttr as never, form, "action") as string | null;
                        ncall(setAttr as never, form, "action", to);
                        try { ncall(submit as never, form); } finally {
                            if (was === null) ncall(removeAttr as never, form, "action"); else ncall(setAttr as never, form, "action", was);
                        }
                        return;
                    }
                }
                ncall((ncall(type, e) === "replace" ? replace : assign) as never, realLocation, to);
            } catch { /* left to the browser */ }
        });
    }
    navigation?.addEventListener("currententrychange", () => {
        const href = unwrapOne(realLocation.href);
        if (href !== realLocation.href) setBaseUrl(href);
    });
}
