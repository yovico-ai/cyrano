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
import { injectIntoIframe } from "./iframe-injection";

function hasOwnLikeProperty(obj: unknown, key: string): boolean {
    return obj !== null && obj !== undefined && key in (obj as object);
}

// Returns a Location-shaped object that forwards reads to `realLoc` but
// proxifies URL-bearing writes so cross-frame navigations go through the proxy.
// Used for non-targetWindow location accesses (e.g. childIframe.contentWindow.location.href = url).
function wrapForeignLoc(
    realLoc: Location,
    rewriteOne: (url: string) => string,
): object {
    return {
        get href() { return realLoc.href; },
        set href(v: string) { realLoc.href = rewriteOne(v); },
        get origin() { return realLoc.origin; },
        get protocol() { return realLoc.protocol; },
        set protocol(v: string) { realLoc.protocol = v; },
        get host() { return realLoc.host; },
        set host(v: string) { realLoc.host = v; },
        get hostname() { return realLoc.hostname; },
        set hostname(v: string) { realLoc.hostname = v; },
        get port() { return realLoc.port; },
        set port(v: string) { realLoc.port = v; },
        get pathname() { return realLoc.pathname; },
        set pathname(v: string) { realLoc.pathname = v; },
        get search() { return realLoc.search; },
        set search(v: string) { realLoc.search = v; },
        get hash() { return realLoc.hash; },
        set hash(v: string) { realLoc.hash = v; },
        assign(url: string) { realLoc.assign(rewriteOne(url)); },
        replace(url: string) { realLoc.replace(rewriteOne(url)); },
        reload() { realLoc.reload(); },
        toString() { return realLoc.href; },
    };
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

    // Mirrors the server's inject.go bootstrapScript() for HTML written via
    // document.write at runtime — injects <script src=...> + init call into
    // any <head> element so inline scripts that reference $rewriter can run.
    const buildBootstrapHtml = (): string => {
        const src = config.apiBaseURL + config.source;
        const configJson = htmlSafeJson(config);
        const locationLit = jsStringLiteral(baseUrlState.get().href);
        return (
            `<script src="${src}"></script>` +
            `<script>window.$rewriter=window.$rewriter_init(window,${configJson}).inject();` +
            `$rewriter.set_location(${locationLit});` +
            `document.currentScript.remove();</script>`
        );
    };

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
            if (arg.obj === targetWindow) {
                return { location: wrappedLocation };
            }
            if (!hasOwnLikeProperty(arg.obj, "location")) {
                return { location: undefined };
            }
            const loc = (arg.obj as { location: unknown }).location;
            if (!loc || typeof loc !== "object") {
                return { location: loc };
            }
            return { location: wrapForeignLoc(loc as Location, rewriteOne) };
        },

        // ── Window tree ────────────────────────────────────────────────────
        wrap_get_top_window: wrapGetTopWindow,
        wrap_top_window: wrapTopWindow,
        wrap_parent_window: wrapParentWindow,
        get_top_level_window: getTopLevelWindow,

        // ── Document.write / postMessage / eval / member expression ────────
        wrap_document_write: (arg) => wrapDocumentWrite(arg, rewriteOne, buildBootstrapHtml, initialBaseUrl.origin),
        wrap_postMessage: (arg) => wrapPostMessage(arg, initialBaseUrl.origin),
        // Computed member access obj[expr] — mirror what the static-access
        // wrappers return so that obj["location"], obj["write"], etc. go
        // through the same interceptors as obj.location, obj.write, etc.
        wrap_member_expression: (obj: unknown, prop: PropertyKey): unknown => {
            switch (prop) {
                case "location":
                    if (obj === targetWindow) return { location: wrappedLocation };
                    if (obj && typeof obj === "object" && "location" in obj) {
                        const loc = (obj as { location: unknown }).location;
                        if (loc && typeof loc === "object") {
                            return { location: wrapForeignLoc(loc as Location, rewriteOne) };
                        }
                    }
                    return obj;
                case "top":
                    return wrapTopWindow({ obj });
                case "parent":
                    return wrapParentWindow({ obj });
                case "write":
                case "writeln":
                    return wrapDocumentWrite({ obj }, rewriteOne, buildBootstrapHtml, initialBaseUrl.origin);
                case "postMessage":
                    return wrapPostMessage({ obj }, initialBaseUrl.origin);
                case "eval":
                    return wrapEvalMemexp(obj);
            }
            return obj;
        },
        wrap_eval: wrapEval,
        wrap_eval_arg: wrapEvalArg,
        wrap_eval_memexp: wrapEvalMemexp,
        // JS_WRAP_IMPORT_ARG — proxify dynamic import() specifiers so module
        // loads go through URL containment like all other resource fetches.
        wrap_import_arg: (specifier) =>
            typeof specifier === "string" ? rewriteOne(specifier) : specifier,
        // JS_WRAP_NEW_WORKER — proxify the url argument of `new Worker(url)` /
        // `new SharedWorker(url)` at the source level so the Worker script is
        // fetched through the proxy even when page code (e.g. reCAPTCHA)
        // restores the native Worker constructor after our prototype patch.
        wrap_worker_url: (url) => {
            // reCAPTCHA passes a TrustedScriptURL object, not a plain string.
            // String(TrustedScriptURL) returns the inner URL, which we can then proxify.
            const urlStr = typeof url === "string" ? url : (url != null ? String(url) : null);
            if (!urlStr) return url;
            return rewriteOne(urlStr);
        },

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

// Produce a double-quoted JS string literal safe to embed inside a <script>
// block. Escapes \, ", control characters, and < (prevents </script> breakout).
function jsStringLiteral(s: string): string {
    let out = '"';
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        const c = s[i]!;
        if (c === "\\") { out += "\\\\"; }
        else if (c === '"') { out += '\\"'; }
        else if (c === "\n") { out += "\\n"; }
        else if (c === "\r") { out += "\\r"; }
        else if (c === "\t") { out += "\\t"; }
        else if (c === "<") { out += "\\x3c"; } // prevent </script> breakout
        else if (code < 0x20) { out += "\\u00" + code.toString(16).padStart(2, "0"); }
        else { out += c; }
    }
    return out + '"';
}

// JSON.stringify with HTML-safe escaping — mirrors Go's json.Marshal which
// escapes <, >, & by default so the JSON is safe inside a <script> block.
function htmlSafeJson(obj: unknown): string {
    return JSON.stringify(obj)
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/&/g, "\\u0026");
}
