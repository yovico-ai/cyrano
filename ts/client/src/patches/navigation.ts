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

import { blobNavigationFor } from "./blob-document";
import type { RewriteOne } from "./referrer-policy";
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
    // The entries a page sees: the contiguous run around the current one of
    // its own original origin (HTML "get session history entries"): every
    // proxied entry is same-origin to the browser, which listed the sites
    // before it too, their URLs and queries (round I).
    const natEntries = (Nav as Record<string, unknown>)["entries"] as ((this: unknown) => unknown[]) | undefined;
    const natCurrent = getter(Nav, "currentEntry");
    const HE = g["NavigationHistoryEntry"]?.prototype;
    const natUrl = getter(HE, "url"), natIndex = getter(HE, "index");
    const natTraverse = (Nav as Record<string, unknown>)["traverseTo"] as ((this: unknown, key: string, o?: unknown) => unknown) | undefined;
    const originOf = (e: unknown): string | null => {
        try { const u = natUrl ? ncall(natUrl, e) : null; return typeof u === "string" ? new URL(unwrapOne(u)).origin : null; } catch { return null; }
    };
    /** The run [from, to) of the native list, and the current entry's place in it. */
    const run = (self: unknown): { list: unknown[]; from: number; to: number; at: number } | null => {
        if (!natEntries || !natCurrent) return null;
        const list = nR.apply(natEntries, self, []) as unknown[];
        const cur = ncall(natCurrent, self);
        let at = -1;
        for (let i = 0; i < list.length; i++) if (list[i] === cur) { at = i; break; }
        if (at < 0) return { list, from: 0, to: list.length, at };
        const o = originOf(list[at]);
        let from = at, to = at + 1;
        while (from > 0 && originOf(list[from - 1]) === o) from--;
        while (to < list.length && originOf(list[to]) === o) to++;
        return { list, from, to, at };
    };
    if (natEntries) {
        wrapMethod<(...a: unknown[]) => unknown>(Nav, "entries", (native, self, args) => {
            const r = run(self);
            if (!r || r.at < 0) return nR.apply(native, self, args);
            return r.list.slice(r.from, r.to);
        });
    }
    if (HE && natIndex) {
        wrapAccessor<number>(HE, "index", {
            get: (native, self) => {
                const i = ncall(native, self) as number;
                if (i < 0) return i;
                const nav = (targetWindow as unknown as { navigation?: unknown }).navigation;
                const r = nav ? run(nav) : null;
                if (!r || r.at < 0) return i;
                return i >= r.from && i < r.to ? i - r.from : -1;
            },
        });
    }
    for (const [k, beyond] of [["canGoBack", (r: { from: number; at: number }) => r.at > r.from], ["canGoForward", (r: { to: number; at: number }) => r.at < r.to - 1]] as const) {
        if (!getter(Nav, k)) continue;
        wrapAccessor<boolean>(Nav, k, {
            get: (native, self) => {
                const r = run(self);
                return r && r.at >= 0 ? beyond(r as never) : (ncall(native, self) as boolean);
            },
        });
    }
    // back() / forward() past the run fail as natively when there is no
    // entry (InvalidStateError, the native's own: a key no entry has).
    for (const [k, beyond] of [["back", (r: { from: number; at: number }) => r.at > r.from], ["forward", (r: { to: number; at: number }) => r.at < r.to - 1]] as const) {
        if (typeof (Nav as Record<string, unknown>)[k] !== "function") continue;
        wrapMethod<(...a: unknown[]) => unknown>(Nav, k, (native, self, args) => {
            const r = run(self);
            if (r && r.at >= 0 && !beyond(r as never) && natTraverse) return nR.apply(natTraverse, self, ["crn\u241fnone", ...args]);
            return nR.apply(native, self, args);
        });
    }
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
                const dest = String(ncall(url, ncall(destination, e)));
                // A blob: HTML document the page built: its rewritten copy.
                const to = netDestination(dest, proxyOrigin, rewriteOne) ?? blobNavigationFor(targetWindow, dest, rewriteOne as RewriteOne, proxyOrigin);
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
