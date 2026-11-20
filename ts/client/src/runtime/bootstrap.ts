// `init(targetWindow, config).inject()` — the function the entry script
// publishes as `window.$rewriter_init`.
//
// The two-step shape (init then inject) is for parity with what the server's
// head-injection script expects. It also makes it easy to construct the API
// without immediately patching globals (useful in tests).

import { patchLocationReflection } from "../patches/location-reflect";
import { isDocumentObject, isWindowObject } from "../native/brand";
import { isView } from "../native/cross-origin";
import { buildBootstrapHtml } from "./bootstrap-html";
import { defineHidden } from "../native/hidden-globals";
import type { ClientConfig } from "../config";
import type { RewriterApi } from "./api-types";
import { createRewriterApi } from "./api";
import { installPatches } from "../patches/install";
import { patchWindowLocation } from "../patches/location";
import { unwrapProxiedUrl } from "../url/containment";
import { internalsOf, publish, type Internals } from "../native/internals";

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
            // the state the installed patches read.
            const existing = internalsOf(targetWindow);
            if (existing) return existing.api;
            const api = createRewriterApi(targetWindow, config);
            const internals: Internals = {
                api,
                bootstrapHtml: () => buildBootstrapHtml(config, (api.get_base_url() ?? new URL(targetWindow.location.href)).href),
            };
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
                config.referrer,
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
            publish(targetWindow, api, internals);
            return api;
        },
    };
}
