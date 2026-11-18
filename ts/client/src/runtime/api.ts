// Builds the `$rewriter` object — the object server-rewritten code calls into.
//
// This module is the composition root for the runtime. It owns the base-URL
// state and the cookie-secret resolution, and delegates each individual
// JS_WRAP_* / hook to the appropriate wrapper module so the responsibilities
// stay narrow. Adding a new wrapper means: write the module, import it here,
// expose it on the returned RewriterApi.

import { crossOriginView } from "../native/cross-origin";
import { markSender } from "../messaging/target-origin";
import { isView } from "../native/cross-origin";
import { buildBootstrapHtml } from "./bootstrap-html";
import { honourOptionalChains } from "./optional";
import type { ClientConfig } from "../config";
import type { RewriterApi } from "./api-types";
import { BaseUrlState } from "./base-url-state";
import { isUrlLikeSpecifier, rewriteUrl, unwrapProxiedUrl } from "../url/containment";
import { foreignLocationView, makeLocationView } from "../wrappers/wrapped-location";
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


/**
 * `win[i]` as page code would see it: a holder whose `i` is the
 * cross-origin view of a child frame of another origin; `win` itself in
 * every other case. Only frame indices: the value is read through its own
 * property descriptor, so no getter a page defined on the window ever runs
 * here (it would run twice, and its own rewritten code would overwrite the
 * `$__crn_key__` temporary of the access in progress — Ad-Shield's traps).
 */
function frameHolder(win: Window, prop: string | number): unknown {
    if (!(typeof prop === "number" ? Number.isInteger(prop) && prop >= 0 : /^(0|[1-9]\d*)$/.test(prop))) return win;
    let value: unknown;
    try {
        const d = Object.getOwnPropertyDescriptor(win, prop);
        if (!d || !("value" in d)) return win;
        value = d.value;
    } catch {
        return win;
    }
    if (typeof value !== "object" || value === null || value === win) return win;
    const view = crossOriginView(value, null, win);
    return view === value ? win : { [prop]: view };
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

    const wrappedLocation = makeLocationView(targetWindow.location, {
        base: () => baseUrlState.get(),
        setBase: (u) => baseUrlState.setFromUrl(u),
        config,
        win: targetWindow,
    });
    // Another window's (or document's) location: its view, or the real one
    // when cyrano does not proxy it.
    // What `obj.location` in rewritten code reads and writes. Reading gives
    // the location view of a window or document, and the object's own
    // property for anything else (a router's `this.location`). Writing
    // navigates a window through containment, and for anything else assigns
    // to the object itself — the page's `this.location = url` must land.
    const isWindowLike = (obj: unknown): boolean => {
        if (obj === targetWindow || obj === targetWindow.document) return true;
        try {
            const o = obj as { window?: unknown; defaultView?: unknown; nodeType?: unknown };
            return (typeof o === "object" && o !== null) && (o.window === o || (o.nodeType === 9 && "defaultView" in o));
        } catch {
            return true; // a cross-origin window
        }
    };
    const locationHolder = (obj: unknown): { location: unknown } => ({
        get location(): unknown {
            if (obj === null || obj === undefined) return (obj as unknown as { location: unknown }).location; // the native TypeError
            if (!isWindowLike(obj)) return (obj as { location: unknown }).location;
            return locationOf(obj);
        },
        set location(v: unknown) {
            if (obj === null || obj === undefined || !isWindowLike(obj)) {
                (obj as { location: unknown }).location = v;
                return;
            }
            (locationOf(obj) as { href: string }).href = String(v);
        },
    });
    const locationOf = (obj: unknown): unknown => {
        if (obj === targetWindow || obj === targetWindow.document) return wrappedLocation;
        // A cross-origin window's location is its view's: settable, not readable.
        if (isView(obj)) return (obj as { location: unknown }).location;
        return foreignLocationView(obj, config);
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
    const buildBootstrap = (): string => buildBootstrapHtml(config, baseUrlState.get().href);

    return honourOptionalChains({
        config,

        // ── Base-URL state ─────────────────────────────────────────────────
        get_base_url: () => baseUrlState.get(),
        set_base_url: (href) => baseUrlState.setFromHref(href),
        set_location: (href) => {
            // The server's head-injection script calls this on page load to
            // declare the page's effective original URL — same intent as
            // set_base_url. Actually navigating here would create a redirect
            // loop, so we just update the base URL.
            // A fragment never reaches the server: the URL it declares has
            // none, and the document's fragment is the one the browser
            // holds (Stripe passes its frames' parameters there).
            let full = href;
            try {
                const frag = (targetWindow as unknown as { location: Location }).location.hash;
                if (frag && typeof href === "string" && href.indexOf("#") < 0) full = href + frag;
            } catch { /* no location */ }
            baseUrlState.setFromHref(full);
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
        wrap_location: (arg) => locationHolder(arg.obj),

        // ── Window tree ────────────────────────────────────────────────────
        // Other windows, as this window's code may see them (native/cross-origin.ts).
        wrap_get_top_window: (top) => wrapGetTopWindow(top, targetWindow),
        wrap_top_window: (arg) => wrapTopWindow(arg, targetWindow),
        wrap_parent_window: (arg) => wrapParentWindow(arg, targetWindow),
        get_top_level_window: getTopLevelWindow,

        // ── Document.write / postMessage / eval / member expression ────────
        wrap_document_write: (arg) => wrapDocumentWrite(arg, rewriteOne, buildBootstrap, initialBaseUrl.origin),
        // Reading `x.postMessage` here: this window is the sender of the call that follows.
        wrap_postMessage: (arg) => {
            markSender(arg.obj, targetWindow);
            return wrapPostMessage(arg, initialBaseUrl.origin, () => baseUrlState.get().origin, (h) => unwrapProxiedUrl(h, config));
        },
        // Computed member access obj[expr] — mirror what the static-access
        // wrappers return so that obj["location"], obj["write"], etc. go
        // through the same interceptors as obj.location, obj.write, etc.
        wrap_member_expression: (obj: unknown, prop: PropertyKey): unknown => {
            switch (prop) {
                case "location":
                    return locationHolder(obj);
                case "top":
                    return wrapTopWindow({ obj }, targetWindow);
                case "parent":
                    return wrapParentWindow({ obj }, targetWindow);
                case "write":
                case "writeln":
                    return wrapDocumentWrite({ obj }, rewriteOne, buildBootstrap, initialBaseUrl.origin);
                case "postMessage":
                    markSender(obj, targetWindow);
                    return wrapPostMessage({ obj }, initialBaseUrl.origin, () => baseUrlState.get().origin, (h) => unwrapProxiedUrl(h, config));
                case "eval":
                    return wrapEvalMemexp(obj);
            }
            // window[i]: a child frame of another origin is
            // the same object page code gets from the iframe's contentWindow
            // or a message's source — natively one WindowProxy (PayPal finds
            // the window a callback came from by enumerating frames).
            if (obj === targetWindow && (typeof prop === "number" || typeof prop === "string")) {
                return frameHolder(obj as Window, prop);
            }
            return obj;
        },
        wrap_eval: wrapEval,
        wrap_eval_arg: wrapEvalArg,
        wrap_eval_memexp: wrapEvalMemexp,
        // JS_WRAP_IMPORT_ARG — proxify dynamic import() specifiers so module
        // loads go through URL containment like all other resource fetches.
        // A relative specifier resolves against the importing script's own URL
        // (`scriptUrl`, passed by the server-side rewriter), not the page's.
        wrap_import_arg: (specifier, scriptUrl) => {
            if (typeof specifier !== "string" || !isUrlLikeSpecifier(specifier)) return specifier;
            let base = baseUrlState.get();
            if (typeof scriptUrl === "string") {
                try { base = new URL(scriptUrl); } catch { /* keep the page's */ }
            }
            return rewriteUrl(specifier, base, config);
        },
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

        // ── Iframe runtime injection ───────────────────────────────────────
        append_rewrite_script_into_iframe: (iframe) => {
            injectIntoIframe(iframe, targetWindow, config, baseUrlState.get().href);
        },
    });
}
