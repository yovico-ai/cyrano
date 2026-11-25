// Builds the `$rewriter` object — the object server-rewritten code calls into.
//
// This module is the composition root for the runtime. It owns the base-URL
// state and the cookie-secret resolution, and delegates each individual
// JS_WRAP_* / hook to the appropriate wrapper module so the responsibilities
// stay narrow. Adding a new wrapper means: write the module, import it here,
// expose it on the returned RewriterApi.

import { hideSecureContext } from "../native/secure-context";
import { rewriteSrcdoc } from "../patches/html-rewriter";
import { navigationUrl } from "../url/js-url";
import { trustworthy } from "../cookies/rfc";
import { nO, nR, sStarts } from "../native/intrinsics";
import { blobScriptFor, dataScriptFor } from "../patches/blob-document";
import { crossOriginView } from "../native/cross-origin";
import { markSender } from "../messaging/target-origin";
import { isView } from "../native/cross-origin";
import { isDocumentObject, isLocationObject, isWindowObject } from "../native/brand";
import { buildBootstrapHtml } from "./bootstrap-html";
import { honourOptionalChains } from "./optional";
import type { ClientConfig } from "../config";
import type { RewriterApi } from "./api-types";
import { BaseUrlState } from "./base-url-state";
import { isUrlLikeSpecifier, rewriteUrl, unwrapProxiedUrl, type Dest } from "../url/containment";
import { unwrapRejection } from "../url/error-text";
import { metaResolver } from "../wrappers/meta-resolve";
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
    wrapEvalArg,
    wrapEvalArgs,
    wrapEvalMemexp,
    registerEvaluator,
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
/** "0", "1", … — by character, never through RegExp (page code can hook its exec). */
function isIndex(s: string): boolean {
    if (s.length === 0 || (s.length > 1 && s.charCodeAt(0) === 48)) return false;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 48 || c > 57) return false;
    }
    return true;
}

function frameHolder(win: Window, prop: string | number): unknown {
    if (!(typeof prop === "number" ? Number.isInteger(prop) && prop >= 0 : isIndex(prop))) return win;
    let value: unknown;
    try {
        const d = nO.getOwnPropertyDescriptor(win, prop);
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
    // This realm's intrinsic eval, before any page code can replace it: a
    // call of it, under any shape the rewriter sees, gets its source rewritten.
    try { registerEvaluator((targetWindow as unknown as { eval: unknown }).eval); } catch { /* a closed or foreign window */ }
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
    // Told apart without reading the object (native/brand.ts); anything
    // else is handed back as it is, so `obj.location` / `obj["location"]`
    // is the object's own property — read, called (with obj as `this`) or
    // assigned exactly as written.
    // Saved at setup: a page may replace it (url/error-text.ts).
    const pageDOMException = (targetWindow as unknown as { DOMException?: new (m: string, n: string) => unknown }).DOMException;
    const isWindowLike = (obj: unknown): boolean =>
        obj === targetWindow || obj === targetWindow.document || isWindowObject(obj) || isDocumentObject(obj) || isView(obj);
    const locationHolder = (obj: unknown): { location: unknown } => {
        if (!isWindowLike(obj)) return obj as { location: unknown };
        return {
            get location(): unknown {
                return locationOf(obj);
            },
            set location(v: unknown) {
                (locationOf(obj) as { href: string }).href = String(v);
            },
        };
    };
    const memberHolder = (obj: unknown, prop: PropertyKey): unknown => {
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
        }
        // window[i]: a child frame of another origin is
        // the same object page code gets from the iframe's contentWindow
        // or a message's source — natively one WindowProxy (PayPal finds
        // the window a callback came from by enumerating frames).
        if (obj === targetWindow && (typeof prop === "number" || typeof prop === "string")) {
            return frameHolder(obj as Window, prop);
        }
        return obj;
    };
    const locationOf = (obj: unknown): unknown => {
        if (obj === targetWindow || obj === targetWindow.document) return wrappedLocation;
        // A cross-origin window's location is its view's: settable, not readable.
        if (isView(obj)) return (obj as { location: unknown }).location;
        return foreignLocationView(obj, config, targetWindow);
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

    let secureJudged = false;
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
            // A document of an origin that is not trustworthy (an http:
            // page) is no secure context, as directly (spec/SecureContext.agda).
            if (!secureJudged) {
                secureJudged = true;
                try { if (!trustworthy(new URL(full))) hideSecureContext(targetWindow); } catch { /* judged by the URL alone */ }
            }
        },

        // ── Location proxy ─────────────────────────────────────────────────
        // A bare `location` is wrapped wherever it stands (the rules do no
        // scope analysis): what the identifier holds tells. A Location is
        // this window's view; anything else — a local `var location =
        // el.parentNode`, a parameter — is the page's own value, untouched.
        wrap_get_location: (loc) => (loc === wrappedLocation || isLocationObject(loc) ? wrappedLocation : loc) as Location,
        wrap_set_location: (loc, setter) => ({
            // Setter pattern: rewrites on assignment. Server emits
            //   $rewriter.wrap_set_location(location, function(v){location=v;}).value = newUrl
            // A local binding gets what the page assigns, as is.
            set value(v: string) {
                setter(loc === wrappedLocation || isLocationObject(loc) ? navigationUrl(String(v), rewriteOne) : v);
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
        // R5: `obj[key]` is `wrap_member_expression(obj, $__crn_key__ = (key))[$__crn_key__]`.
        // Whatever runs in here can reach page code (a hooked native, a
        // getter), and page code is rewritten too: its own accesses set
        // `$__crn_key__`. The key is put back on the way out, so the access
        // reads the key the page wrote (Ad-Shield hooks natives in its
        // integrity checks; its `window["Array"]["from"]` read "call").
        // R14: `const {location: L} = window` (and an assignment pattern)
        // reads its source through this: a window's or document's location,
        // top and parent as `obj.location` etc. give them; anything else is
        // the source itself. The Proxy is only destructured — page code never
        // holds it — and every other read is the source's own (Transcend's
        // consent manager read the proxy's origin and refused to run).
        wrap_pattern: (source: unknown): unknown => {
            if (!isWindowLike(source)) return source;
            return new Proxy(source as object, {
                get: (t, k) => (k === "location" || k === "top" || k === "parent"
                    ? (memberHolder(t, k) as Record<PropertyKey, unknown>)[k]
                    : nR.get(t, k, t)),
            });
        },
        wrap_member_expression: (obj: unknown, prop: PropertyKey): unknown => {
            // The common case first, and nothing else on its way: a key that
            // is no string (an index, a symbol) on an object that is not this
            // window names nothing the rules know. Rewritten code spends its
            // time here when it is an interpreter — a challenge's bytecode
            // loop runs unoptimized, where every operation and call counts
            // (Cloudflare's Turnstile froze techcrunch.com for a minute).
            // No code ran in between, so the key is as the caller set it.
            if (obj !== targetWindow) {
                if (typeof prop !== "string") return obj;
                // A string: told from the names below by its length and first
                // letter before it is compared with them — unoptimized, each
                // comparison of two strings is a call, and Turnstile makes
                // tens of millions of string-keyed accesses a run. (No method
                // of String is called: a page can have replaced them.)
                // (Turnstile's commonest keys are one character, "length" and "push".)
                const c = prop[0];
                switch (prop.length) {
                    case 3: if (c !== "t") return obj; break; // top
                    case 5: if (c !== "w") return obj; break; // write
                    case 6: if (c !== "p") return obj; break; // parent
                    case 7: if (c !== "w") return obj; break; // writeln
                    case 8: if (c !== "l") return obj; break; // location
                    case 11: if (c !== "p") return obj; break; // postMessage
                    default: return obj;
                }
                switch (prop) {
                    case "location": case "top": case "parent": case "write": case "writeln": case "postMessage":
                        break; // memberHolder's
                    default:
                        return obj;
                }
            }
            const holder = memberHolder(obj, prop);
            (targetWindow as unknown as { $__crn_key__: unknown }).$__crn_key__ = prop;
            return holder;
        },
        // A read of eval gives eval itself (spec/Eval.agda): what reads it
        // may call it as eval(…), a direct eval only with the intrinsic.
        // (Kept for scripts rewritten before R1 stopped wrapping eval.)
        wrap_eval: (f: typeof eval): typeof eval => f,
        wrap_eval_arg: wrapEvalArg,
        wrap_eval_args: wrapEvalArgs,
        wrap_eval_memexp: wrapEvalMemexp,
        // JS_WRAP_IMPORT_ARG — proxify dynamic import() specifiers so module
        // loads go through URL containment like all other resource fetches.
        // A relative specifier resolves against the importing script's own URL
        // (`scriptUrl`, passed by the server-side rewriter), not the page's.
        // The import's rejection names the page's URL, as natively (url/error-text.ts).
        wrap_import_result: (p) => unwrapRejection(p, new URL(config.apiBaseURL).origin, (u) => unwrapProxiedUrl(u, config), pageDOMException),
        // A javascript: URL's completion value (spec/JsUrl.agda): a string
        // becomes the new document, so it is rewritten as one, with the
        // bootstrap; anything else as it is.
        js_url_result: (_target, r) => (typeof r === "string" ? rewriteSrcdoc(r, rewriteOne, initialBaseUrl.origin, buildBootstrap) : r),
        wrap_import_arg: (specifier, scriptUrl) => {
            // import() takes the string of whatever it is given: a URL object
            // (`import(new URL("/a.js", import.meta.url))`: Vite, Yext's
            // subway.com pages) went to the origin. Its toString runs once,
            // here; one that throws rejects the import, as natively (the
            // native's own ToString then meets the same error).
            if (typeof specifier === "symbol") return specifier; // the native's TypeError
            if (typeof specifier !== "string") {
                try {
                    specifier = String(specifier);
                } catch (e) {
                    return { toString(): never { throw e; } };
                }
            }
            if (!isUrlLikeSpecifier(specifier as string)) return specifier;
            // A module the page built (a blob: URL): rewritten as a module (patches/blob-document.ts).
            if (sStarts((specifier as string).toLowerCase(), "blob:")) {
                const rw = Object.assign((u: string): string => rewriteUrl(u, baseUrlState.get(), config), {
                    withMark: (u: string, p: string | null, d: Dest | null): string => rewriteUrl(u, baseUrlState.get(), config, p ?? undefined, d ?? undefined),
                });
                return blobScriptFor(targetWindow, specifier as string, rw, true) ?? specifier;
            }
            // A module given as a data: URL: its text rewritten (spec/DataUrl.agda).
            if (sStarts((specifier as string).replace(/^[\x00-\x20]+/, "").toLowerCase(), "data:")) {
                const rw = Object.assign((u: string): string => rewriteUrl(u, baseUrlState.get(), config), {
                    withMark: (u: string, p: string | null, d: Dest | null): string => rewriteUrl(u, baseUrlState.get(), config, p ?? undefined, d ?? undefined),
                });
                return dataScriptFor(specifier as string, rw) ?? specifier;
            }
            let base = baseUrlState.get();
            if (typeof scriptUrl === "string") {
                try { base = new URL(scriptUrl); } catch { /* keep the page's */ }
            }
            // A module's URL: marked as a script's (spec/Containment.agda Dest).
            return rewriteUrl(specifier as string, base, config, undefined, "js");
        },
        // JS_WRAP_NEW_WORKER — proxify the url argument of `new Worker(url)` /
        // `new SharedWorker(url)` at the source level so the Worker script is
        // fetched through the proxy even when page code (e.g. reCAPTCHA)
        // restores the native Worker constructor after our prototype patch.
        wrap_meta_resolve: metaResolver(config),
        wrap_worker_url: (url) => {
            // reCAPTCHA passes a TrustedScriptURL object, not a plain string.
            // String(TrustedScriptURL) returns the inner URL, which we can then proxify.
            if (typeof url === "symbol") return url; // the constructor's own TypeError
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
