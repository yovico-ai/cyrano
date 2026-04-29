// Builds the `$rewriter` object — the object server-rewritten code calls into.
//
// This module is the composition root for the runtime. It owns the base-URL
// state and the cookie-secret resolution, and delegates each individual
// JS_WRAP_* / hook to the appropriate wrapper module so the responsibilities
// stay narrow. Adding a new wrapper means: write the module, import it here,
// expose it on the returned RewriterApi.

import type { ClientConfig } from "../config";
import type { RewriterApi } from "./api-types";
import { BaseUrlState } from "./base-url-state";
import { rewriteUrl } from "../url/containment";
import { readCookieValue } from "../cookies/document-cookie";
import { applyCookiePayload } from "../cookies/apply-payload";
import { syncCookiesForResources } from "../cookies/sync";
import { WrappedLocation } from "../wrappers/wrapped-location";
import {
    wrapGetTopWindow,
    wrapTopWindow,
    wrapParentWindow,
    getTopLevelWindow,
} from "../wrappers/window-tree";
import { wrapDocumentWrite } from "../wrappers/document-write";
import { wrapPostMessage } from "../wrappers/post-message";
import {
    wrapEval,
    wrapEvalArg,
    wrapEvalMemexp,
} from "../wrappers/eval";
import { wrapMemberExpression } from "../wrappers/member-expression";
import { injectIntoIframe } from "./iframe-injection";

function hasOwnLikeProperty(obj: unknown, key: string): boolean {
    return obj !== null && obj !== undefined && key in (obj as object);
}

export function createRewriterApi(
    targetWindow: Window,
    config: ClientConfig,
): RewriterApi {
    // Initial base URL — derived from the configured public origin. The
    // server's bootstrap script will overwrite this via set_base_url() with
    // the actual page URL the proxy is masquerading.
    const initialBaseUrl = new URL(config.apiBaseURL);
    const baseUrlState = new BaseUrlState(initialBaseUrl);

    const wrappedLocation = new WrappedLocation(
        baseUrlState,
        targetWindow.location,
        config,
    );

    // Lazy resolver for the per-session secret used to decrypt cookie payloads.
    // The secret cookie may be set by the bootstrap *after* createRewriterApi
    // returns but before the first cookie helper is called, so we read from
    // document.cookie on demand rather than caching at construction time.
    const resolveSessionSecret = (): string => {
        if (!config.userDataEncryption) return "";
        return readCookieValue(config.secretCookieName, targetWindow.document) ?? "";
    };

    // Single rewriter closure shared by every wrapper that needs to proxify
    // a URL string against the *current* base URL. The base URL changes over
    // a page's lifetime (set_base_url / set_location), so we resolve it on
    // every call rather than capturing once.
    const rewriteOne = (rawUrl: string): string =>
        rewriteUrl(rawUrl, baseUrlState.get(), config);

    return {
        config,

        // ── Base-URL state ─────────────────────────────────────────────────
        get_base_url: () => baseUrlState.get(),
        set_base_url: (href) => baseUrlState.setFromHref(href),
        set_location: (href) => {
            // The server's head-injection script calls this on page load to
            // declare the page's effective original URL — same intent as
            // set_base_url. Actually navigating here would create a redirect
            // loop, so we just update the base URL.
            baseUrlState.setFromHref(href);
        },
        set_cookies: (payload) => {
            applyCookiePayload(payload, resolveSessionSecret());
        },

        // ── Location proxy ─────────────────────────────────────────────────
        wrap_get_location: (_loc) => wrappedLocation,
        wrap_set_location: (_loc, setter) => ({
            // Setter pattern: rewrites on assignment. Server emits
            //   $rewriter.wrap_set_location(location, function(v){location=v;}).value = newUrl
            set value(v: string) {
                setter(rewriteOne(v));
            },
            // The getter is required by the type but server-rewritten code
            // never reads it. Return the base URL to satisfy TS without lying
            // about state.
            get value(): string {
                return baseUrlState.get().href;
            },
        }),
        wrap_location: (arg) => {
            // Server rewrites `obj.location` →
            //   `$rewriter.wrap_location({obj}).location`
            // When `obj` is the local window, return the WrappedLocation;
            // otherwise pass through best-effort.
            if (arg.obj === targetWindow) {
                return { location: wrappedLocation };
            }
            return {
                location: hasOwnLikeProperty(arg.obj, "location")
                    ? (arg.obj as { location: unknown }).location
                    : undefined,
            };
        },

        // ── Window tree ────────────────────────────────────────────────────
        wrap_get_top_window: wrapGetTopWindow,
        wrap_top_window: wrapTopWindow,
        wrap_parent_window: wrapParentWindow,
        get_top_level_window: getTopLevelWindow,

        // ── Document.write / postMessage / eval / member expression ────────
        wrap_document_write: (arg) => wrapDocumentWrite(arg, rewriteOne),
        wrap_postMessage: wrapPostMessage,
        wrap_member_expression: wrapMemberExpression,
        wrap_eval: wrapEval,
        wrap_eval_arg: wrapEvalArg,
        wrap_eval_memexp: wrapEvalMemexp,

        // ── Cookie hooks ───────────────────────────────────────────────────
        // Both fire from server-injected onload= handlers on script/iframe/img
        // tags. They mean: "this resource just loaded — go ask the proxy for
        // any cookies the origin server set in its response."
        process_server_cookies: () => {
            const currentScript = targetWindow.document.currentScript as
                | HTMLScriptElement
                | null;
            const src = currentScript?.src;
            if (src) {
                void syncCookiesForResources([src], config, resolveSessionSecret());
            }
        },
        fetch_cookies: (elem, callback) => {
            const src = (elem as Partial<HTMLImageElement>).src;
            if (src) {
                void syncCookiesForResources([src], config, resolveSessionSecret())
                    .finally(() => callback?.());
            } else {
                callback?.();
            }
        },

        // ── Iframe runtime injection ───────────────────────────────────────
        append_rewrite_script_into_iframe: (iframe) => {
            injectIntoIframe(iframe, targetWindow, config, baseUrlState.get().href);
        },
    };
}
