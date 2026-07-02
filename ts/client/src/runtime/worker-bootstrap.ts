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

import type { ClientConfig } from "../config";
import { rewriteUrl, unwrapProxiedUrl } from "../url/containment";
import { WorkerWrappedLocation } from "../wrappers/worker-location";
import {
    wrapGetTopWindow,
    wrapTopWindow,
    wrapParentWindow,
} from "../wrappers/window-tree";
import { wrapDocumentWrite } from "../wrappers/document-write";
import { wrapPostMessage } from "../wrappers/post-message";
import { wrapEval, wrapEvalArg, wrapEvalMemexp } from "../wrappers/eval";

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
    wrap_eval(evalFn: typeof eval): typeof eval;
    wrap_eval_arg(evalFn: typeof eval, source: unknown): unknown;
    wrap_eval_memexp(obj: unknown): unknown;
    wrap_import_arg(specifier: unknown): unknown;
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
    scope: PatchableWorkerScope = globalThis as unknown as PatchableWorkerScope,
): WorkerRewriterApi {
    const baseUrl = new URL(hrefAtCreation);
    const wrappedLocation = new WorkerWrappedLocation(hrefAtCreation);
    const rewriteOne = (rawUrl: string): string => rewriteUrl(rawUrl, baseUrl, config);
    const unwrapOne = (proxiedUrl: string): string => unwrapProxiedUrl(proxiedUrl, config);

    patchWorkerScope(scope, rewriteOne, unwrapOne);

    const api: WorkerRewriterApi = {
        wrap_get_location: (_loc) => wrappedLocation,
        wrap_set_location: (_loc, setter) => ({
            set value(v: string) { setter(rewriteOne(v)); },
            get value(): string { return baseUrl.href; },
        }),
        wrap_location: (arg) => {
            if (!arg.obj || typeof arg.obj !== "object" || !("location" in arg.obj)) {
                return { location: undefined };
            }
            return { location: wrappedLocation };
        },
        wrap_get_top_window: wrapGetTopWindow as WorkerRewriterApi["wrap_get_top_window"],
        wrap_top_window: wrapTopWindow,
        wrap_parent_window: wrapParentWindow,
        wrap_document_write: (arg) => wrapDocumentWrite(arg, rewriteOne),
        wrap_postMessage: (arg) => wrapPostMessage(arg, new URL(config.apiBaseURL).origin),
        wrap_member_expression: (obj, prop) => {
            switch (prop) {
                case "location":
                    return obj && typeof obj === "object" && "location" in obj
                        ? { location: wrappedLocation }
                        : obj;
                case "top":
                    return wrapTopWindow({ obj });
                case "parent":
                    return wrapParentWindow({ obj });
                case "write":
                case "writeln":
                    return wrapDocumentWrite({ obj }, rewriteOne);
                case "postMessage":
                    return wrapPostMessage({ obj }, new URL(config.apiBaseURL).origin);
                case "eval":
                    return wrapEvalMemexp(obj);
            }
            return obj;
        },
        wrap_eval: wrapEval,
        wrap_eval_arg: wrapEvalArg,
        wrap_eval_memexp: wrapEvalMemexp,
        wrap_import_arg: (specifier) =>
            typeof specifier === "string" ? rewriteOne(specifier) : specifier,
        wrap_worker_url: (url) => {
            const urlStr = typeof url === "string" ? url : (url != null ? String(url) : null);
            return urlStr ? rewriteOne(urlStr) : url;
        },
    };
    return api;
}

/**
 * Patches this worker's own `fetch`/`XMLHttpRequest`/`importScripts` so its
 * outbound requests are proxified the same way the main thread's are — the
 * fix for bare, un-prefixed requests landing on the proxy's own origin.
 */
function patchWorkerScope(
    scope: PatchableWorkerScope,
    rewriteOne: (url: string) => string,
    unwrapOne: (url: string) => string,
): void {
    if (scope.fetch) {
        const nativeFetch = scope.fetch.bind(scope);
        scope.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            if (typeof input === "string") return nativeFetch(rewriteOne(input), init);
            if (input instanceof URL) return nativeFetch(rewriteOne(input.href), init);
            if (typeof Request !== "undefined" && input instanceof Request) {
                return nativeFetch(new Request(rewriteOne(input.url), input), init);
            }
            return nativeFetch(rewriteOne(String(input)), init);
        }) as typeof fetch;

        for (const Ctor of [
            typeof Request !== "undefined" ? Request : undefined,
            typeof Response !== "undefined" ? Response : undefined,
        ]) {
            if (!Ctor?.prototype) continue;
            const urlDesc = Object.getOwnPropertyDescriptor(Ctor.prototype, "url");
            if (!urlDesc?.get) continue;
            const nativeGet = urlDesc.get;
            Object.defineProperty(Ctor.prototype, "url", {
                ...urlDesc,
                get(): string { return unwrapOne(nativeGet.call(this) as string); },
            });
        }
    }

    if (scope.XMLHttpRequest?.prototype) {
        const proto = scope.XMLHttpRequest.prototype;
        const originalOpen = proto.open;
        proto.open = function patchedOpen(
            this: XMLHttpRequest,
            method: string,
            url: string | URL,
            ...rest: unknown[]
        ): void {
            const rawUrl = typeof url === "string" ? url : String(url);
            return (originalOpen as (...args: unknown[]) => void).call(
                this, method, rewriteOne(rawUrl), ...rest,
            );
        } as typeof proto.open;

        const responseURLDesc = Object.getOwnPropertyDescriptor(proto, "responseURL");
        if (responseURLDesc?.get) {
            const nativeGet = responseURLDesc.get;
            Object.defineProperty(proto, "responseURL", {
                ...responseURLDesc,
                get(): string { return unwrapOne(nativeGet.call(this) as string); },
            });
        }
    }

    // importScripts is classic-worker-only (absent in module workers) and
    // synchronous — rewrite every URL argument before delegating.
    if (typeof scope.importScripts === "function") {
        const nativeImportScripts = scope.importScripts.bind(scope);
        scope.importScripts = (...urls: string[]): void => {
            nativeImportScripts(...urls.map(rewriteOne));
        };
    }
}
