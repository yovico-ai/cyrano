// initWorker(config, href) — builds the `$rewriter`-equivalent object for a
// Worker's own global scope, and patches that scope's fetch/XHR/importScripts.
//
// Workers are a SEPARATE JS execution context from the page: `window`-level
// prototype patches (patches/install.ts) never apply inside one. Without this,
// a Worker's own `fetch`/`XMLHttpRequest`/`importScripts` calls to relative or
// absolute-path URLs resolve and dispatch against the worker's own origin
// un-rewritten — landing bare, un-prefixed requests on the proxy's own
// listener instead of being routed to the upstream. See
// patches/blob-worker-source.ts for how this gets invoked (a synchronous
// `importScripts()` call prepended to the worker's own source, followed by a
// call to the function this module exposes as `self.$rewriter_init_worker`).
//
// Most JS_WRAP_* helpers are plain functions with no DOM dependency and are
// reused verbatim from the main-thread wrapper modules — only location
// (WorkerLocation has no assign/replace/reload) and the fetch/XHR/
// importScripts patching are worker-specific.

import { nR } from "../native/intrinsics";
import { patchReflection } from "../native/hidden-globals";
import { patchStorageNames } from "../patches/storage";
import { honourOptionalChains } from "./optional";
import type { ClientConfig } from "../config";
import { isUrlLikeSpecifier, rewriteUrl, unwrapProxiedUrl } from "../url/containment";
import { metaResolver } from "../wrappers/meta-resolve";
import { WorkerWrappedLocation } from "../wrappers/worker-location";
import {
    wrapGetTopWindow,
    wrapTopWindow,
    wrapParentWindow,
} from "../wrappers/window-tree";
import { wrapDocumentWrite } from "../wrappers/document-write";
import { wrapPostMessage } from "../wrappers/post-message";
import { wrapEval, wrapEvalArg, wrapEvalMemexp } from "../wrappers/eval";
import { installToStringMask, wrapAccessor, wrapMethod } from "../native/surface";
import { patchErrorStacks } from "../native/error-stack";
import { patchFetch } from "../patches/fetch";
import { initTrusted, isTrustedValue, trusted } from "../native/trusted";
import { patchResponseHeaders } from "../patches/response-headers";
import { patchXmlHttpRequest } from "../patches/xhr";
import { patchWebSocket } from "../patches/websocket";
import { patchEventSource } from "../patches/event-source";
import { patchWorker } from "../patches/worker";
import { patchFunctionConstructor } from "../patches/function-ctor";

// Subset of RewriterApi (api-types.ts) that's meaningful inside a Worker —
// no DOM, no cookies, no iframe/window-tree navigation.
export interface WorkerRewriterApi {
    wrap_get_location(loc: unknown): WorkerWrappedLocation;
    wrap_set_location(loc: unknown, setter: (v: string) => void): { value: string };
    wrap_location(arg: { obj: unknown }): { location: unknown };
    wrap_get_top_window(top: unknown): unknown;
    wrap_top_window(arg: { obj: unknown }): { top: unknown };
    wrap_parent_window(arg: { obj: unknown }): { parent: unknown };
    wrap_document_write(arg: { obj: unknown }): unknown;
    wrap_postMessage(arg: { obj: unknown }): unknown;
    wrap_member_expression(obj: unknown, prop: PropertyKey): unknown;
    wrap_pattern(source: unknown): unknown;
    wrap_eval(evalFn: typeof eval): typeof eval;
    wrap_eval_arg(evalFn: typeof eval, source: unknown): unknown;
    wrap_eval_memexp(obj: unknown): unknown;
    wrap_import_arg(specifier: unknown, scriptUrl?: unknown): unknown;
    wrap_meta_resolve(meta: unknown): unknown;
    wrap_worker_url(url: unknown): unknown;
}

/** Minimal shape we need from the worker's global scope — avoids depending on `WorkerGlobalScope` lib types. */
interface PatchableWorkerScope {
    fetch?: typeof fetch;
    XMLHttpRequest?: typeof XMLHttpRequest;
    importScripts?: (...urls: string[]) => void;
}

export function initWorker(
    config: ClientConfig,
    hrefAtCreation: string,
    policy?: unknown,
    scope: PatchableWorkerScope = globalThis as unknown as PatchableWorkerScope,
): WorkerRewriterApi {
    // The runtime's Trusted Types policy: the preamble made it to load the
    // runtime with (native/trusted.ts).
    initTrusted(scope, config.tt, policy);
    const baseUrl = new URL(hrefAtCreation);
    const wrappedLocation = new WorkerWrappedLocation(hrefAtCreation);
    const rewriteOne = (rawUrl: string): string => rewriteUrl(rawUrl, baseUrl, config);
    const unwrapOne = (proxiedUrl: string): string => unwrapProxiedUrl(proxiedUrl, config);

    patchWorkerScope(scope, config, baseUrl, rewriteOne, unwrapOne);

    const api: WorkerRewriterApi = {
        wrap_get_location: (_loc) => wrappedLocation,
        wrap_set_location: (_loc, setter) => ({
            set value(v: string) { setter(rewriteOne(v)); },
            get value(): string { return baseUrl.href; },
        }),
        // The worker scope's own location is the view; any other object's
        // `location` is its own property, read and written in place.
        wrap_location: (arg) => ({
            get location(): unknown {
                return arg.obj === scope ? wrappedLocation : (arg.obj as { location: unknown }).location;
            },
            set location(v: unknown) {
                if (arg.obj !== scope) (arg.obj as { location: unknown }).location = v;
            },
        }),
        wrap_get_top_window: wrapGetTopWindow as WorkerRewriterApi["wrap_get_top_window"],
        wrap_top_window: wrapTopWindow,
        wrap_parent_window: wrapParentWindow,
        wrap_document_write: (arg) => wrapDocumentWrite(arg, rewriteOne),
        wrap_postMessage: (arg) => wrapPostMessage(arg, new URL(config.apiBaseURL).origin, () => null, (h: string) => h),
        // R14: a pattern destructured from the worker's global reads its
        // location view (no top / parent in a worker).
        wrap_pattern: (source) => (source === scope
            ? new Proxy(scope as object, { get: (t, k) => (k === "location" ? wrappedLocation : nR.get(t, k, t)) })
            : source),
        wrap_member_expression: (obj, prop) => {
            switch (prop) {
                case "location":
                    return obj === scope ? { location: wrappedLocation } : obj;
                case "top":
                    return wrapTopWindow({ obj });
                case "parent":
                    return wrapParentWindow({ obj });
                case "write":
                case "writeln":
                    return wrapDocumentWrite({ obj }, rewriteOne);
                case "postMessage":
                    return wrapPostMessage({ obj }, new URL(config.apiBaseURL).origin, () => null, (h: string) => h);
                case "eval":
                    return wrapEvalMemexp(obj);
            }
            return obj;
        },
        wrap_eval: wrapEval,
        wrap_eval_arg: wrapEvalArg,
        wrap_eval_memexp: wrapEvalMemexp,
        wrap_import_arg: (specifier, scriptUrl) => {
            if (typeof specifier !== "string" || !isUrlLikeSpecifier(specifier)) return specifier;
            let base = baseUrl;
            if (typeof scriptUrl === "string") {
                try { base = new URL(scriptUrl); } catch { /* keep the worker's */ }
            }
            // A module's URL: marked as a script's (spec/Containment.agda Dest).
            return rewriteUrl(specifier, base, config, undefined, "js");
        },
        wrap_meta_resolve: metaResolver(config),
        wrap_worker_url: (url) => {
            const urlStr = typeof url === "string" ? url : (url != null ? String(url) : null);
            return urlStr ? rewriteOne(urlStr) : url;
        },
    };
    return honourOptionalChains(api);
}

/**
 * Patches this worker's own scope with the same native-surface patches the
 * page gets (fetch, XHR, WebSocket, EventSource, nested workers, error
 * stacks, Function), plus importScripts, and WorkerLocation reading back
 * the worker's original URL.
 */
function patchWorkerScope(
    scope: PatchableWorkerScope,
    config: ClientConfig,
    baseUrl: URL,
    rewriteOne: (url: string) => string,
    unwrapOne: (url: string) => string,
): void {
    const realm = scope as unknown as Window;
    installToStringMask(scope as unknown as typeof globalThis);
    try { patchReflection(scope as object); } catch { /* stays native */ }
    patchErrorStacks(realm, config.apiBaseURL + config.source, unwrapOne);
    // A worker made of a blob: or data: URL sends no Referer: its requests
    // name its origin to the proxy (patches/cors.ts).
    let unreferred = false;
    try { unreferred = /^(blob|data):/i.test(String((scope as unknown as { location?: { href?: string } }).location?.href)); } catch { /* no location */ }
    let opaque = false;
    try { opaque = String((scope as unknown as { origin?: unknown }).origin) === "null"; } catch { /* not opaque */ }
    const cors = config.identity ? undefined
        : { origin: () => baseUrl.origin, href: () => baseUrl.href, always: unreferred, proxy: new URL(config.apiBaseURL).origin, opaque };
    patchFetch(realm, rewriteOne, unwrapOne, () => baseUrl, cors);
    patchXmlHttpRequest(realm, rewriteOne, unwrapOne, () => baseUrl, cors);
    try { patchResponseHeaders(realm); } catch { /* stays native */ }
    patchWebSocket(realm, rewriteOne, unwrapOne, () => baseUrl.origin);
    // IndexedDB, caches and broadcast channels are this origin's alone
    // (patches/storage.ts). A worker does not know its top document: its
    // names are its origin's, unpartitioned.
    try { patchStorageNames(scope as object, () => "crn\u001f" + baseUrl.origin + "\u001f"); } catch { /* stays native */ }
    patchEventSource(realm, rewriteOne, unwrapOne);
    patchWorker(realm, rewriteOne);
    patchFunctionConstructor(realm);
    // importScripts is classic-worker-only and synchronous.
    if (typeof scope.importScripts === "function") {
        wrapMethod<(...a: unknown[]) => void>(scope, "importScripts", (native, self, args) =>
            nR.apply(native, self, args.map((u) => {
                // A script's URL: marked so (spec/Containment.agda Dest).
                const r = rewriteUrl(String(u), baseUrl, config, undefined, "js");
                return isTrustedValue(u) ? trusted(scope, "ScriptURL", r) : r;
            })) as void);
    }
    // self.location is a WorkerLocation; its accessors report the worker's
    // original URL (natively the worker script's own URL).
    const WL = (scope as unknown as { WorkerLocation?: { prototype: object } }).WorkerLocation;
    if (WL?.prototype) {
        for (const part of ["href", "origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"] as const) {
            wrapAccessor<string>(WL.prototype, part, { get: () => baseUrl[part] });
        }
        wrapMethod(WL.prototype, "toString", () => baseUrl.href);
    }
}
