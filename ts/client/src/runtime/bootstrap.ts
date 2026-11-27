// `init(targetWindow, config).inject()` — the function the entry script
// publishes as `window.$rewriter_init`.
//
// The two-step shape (init then inject) is for parity with what the server's
// head-injection script expects. It also makes it easy to construct the API
// without immediately patching globals (useful in tests).

import { srcdocReferrerFrom } from "../url/srcdoc-referrer";
import { patchLocationReflection } from "../patches/location-reflect";
import { isDocumentObject, isWindowObject } from "../native/brand";
import { isView } from "../native/cross-origin";
import { buildBootstrapHtml, buildXmlBootstrap } from "./bootstrap-html";
import { defineHidden } from "../native/hidden-globals";
import type { ClientConfig } from "../config";
import type { RewriterApi } from "./api-types";
import { createRewriterApi } from "./api";
import { installPatches } from "../patches/install";
import { patchWindowLocation } from "../patches/location";
import { unwrapProxiedUrl } from "../url/containment";
import { internalsOf, publish, type Internals } from "../native/internals";
import { nO, nR } from "../native/intrinsics";

export interface RewriterBootstrap {
    inject(): RewriterApi;
}

export function init(
    targetWindow: Window,
    config: ClientConfig,
): RewriterBootstrap {
    return {
        inject(): RewriterApi {
            // A window is patched once. A second initialization — the page's
            // own bootstrap after a parent injected the runtime into the
            // same window, which a same-origin navigation from about:blank
            // keeps — gets the first one's API, so its set_location reaches
            // the state the installed patches read; the document it is for
            // brings its own config (cookies, policies, referrer…).
            const existing = internalsOf(targetWindow);
            if (existing) {
                adoptDocument(targetWindow, existing, config as unknown as Record<string, unknown>);
                if ((targetWindow as unknown) === globalThis && !existing.realmApply) existing.realmApply = (f, s, a) => nR.apply(f as (...x: unknown[]) => unknown, s, a);
                return existing.api;
            }
            const api = createRewriterApi(targetWindow, config);
            const internals: Internals = {
                api,
                bootstrapHtml: (srcdoc?: boolean) => buildBootstrapHtml(config, (api.get_base_url() ?? new URL(targetWindow.location.href)).href,
                    srcdoc ? srcdocReferrerFrom(targetWindow, config) : undefined),
                bootstrapHtmlAt: (href: string) => buildBootstrapHtml(config, href),
                bootstrapXmlAt: (ns, href) => buildXmlBootstrap(config, ns, href),
                config: config as unknown as Record<string, unknown>,
                init: init as unknown as NonNullable<Internals["init"]>,
            };
            try { internals.doc = targetWindow.document; } catch { /* none */ }
            installPatches(
                targetWindow,
                () => api.get_base_url(),
                (href) => api.set_base_url(href),
                config,
                internals,
            );
            // Globally override window.location so unmodified scripts (e.g.
            // Cloudflare challenge.js) see the upstream URL, not the proxy URL.
            patchWindowLocation(
                targetWindow,
                api.wrap_get_location(targetWindow.location),
                (u) => unwrapProxiedUrl(u, config),
                () => config.referrer,
                () => api.get_base_url() ?? new URL(targetWindow.location.href),
            );
            // `location` reached through reflection is the view too (patches/location-reflect.ts).
            patchLocationReflection(
                targetWindow,
                (o) => api.wrap_location({ obj: o }) as { location: unknown },
                (o) => o === targetWindow || o === targetWindow.document || isWindowObject(o) || isDocumentObject(o) || isView(o),
            );
            // Publish the shared bracket-key variable as a writable global property.
            // The server and client JS rewriters emit `$__crn_key__ = expr` to
            // capture dynamic member-expression keys. In strict-mode eval contexts,
            // assigning to an undeclared name throws ReferenceError; declaring it
            // here as a window property ensures any strict-mode eval'd fragment can
            // assign to it without error (assigning to an existing global property
            // is always permitted).
            defineHidden(targetWindow, "$__crn_key__", null);
            // This copy's functions are of this window's realm only when loaded into it.
            if ((targetWindow as unknown) === globalThis) internals.realmApply = (f, s, a) => nR.apply(f as (...x: unknown[]) => unknown, s, a);
            publish(targetWindow, api, internals);
            return api;
        },
    };
}

/**
 * A window's next document — one that took over the window (and realm) of
 * its initial about:blank, which its creator had given the runtime (a frame
 * on its way to a proxied URL; spec/Frames.agda pendingFrame) — gets what
 * is its own: its config replaces the one the patches read (in place: they
 * hold it), and what is installed on a document rather than the realm is
 * installed on it. `config` is that document's own (its bootstrap's), or
 * none (a document with no runtime of its own: the creator's stays).
 */
export function adoptDocument(win: Window, internals: Internals, config?: Record<string, unknown>): void {
    const live = internals.config;
    if (config && live && config !== live) {
        for (const k of nO.keys(live)) delete live[k];
        nO.assign(live, config);
    }
    let doc: unknown;
    try { doc = win.document; } catch { return; }
    if (internals.doc === doc) return;
    internals.doc = doc;
    for (const step of internals.perDocument ?? []) { try { step(); } catch { /* as it is */ } }
}
