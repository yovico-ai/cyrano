// Worker scripts built from Blobs get their own $rewriter — without
// touching the page's Blob.
//
// Anti-bot challenge scripts (Cloudflare's included) commonly run their
// fingerprinting logic in a Worker built like:
//
//   new Worker(URL.createObjectURL(new Blob([src], {type: "text/javascript"})))
//
// A Worker is a separate realm: window-level patches never apply there, and
// a blob: worker's relative fetch/XHR resolve against the proxy origin. Its
// source must be rewritten and preceded by the worker runtime.
//
// The page cannot tell (REQUIREMENTS.md), so the page's own Blob stays
// exactly as the page made it — its size, text() and any hash of it are
// native. Instead:
//   * the Blob constructor only records the source of a JS-typed Blob made
//     of strings (the Blob returned is the native one);
//   * URL.createObjectURL maps the object URL to that source;
//     URL.revokeObjectURL forgets it;
//   * new Worker(thatURL) is given a private object URL whose Blob holds the
//     worker runtime preamble and the rewritten source (workerScriptFor).
//
// Non-string parts (ArrayBuffer, TypedArray, nested Blob) are not recorded —
// arbitrary binary content can't safely be treated as JS source text.
//
// Known gap: the object URL's origin is the proxy's (blob:http://proxy/…)
// where natively it is the site's; translating blob: URLs is a follow-up.
import type { ClientConfig } from "../config";
import { rewriteJsSource, defaultJsRewriteOptions } from "../js/rewriter";
import { wrapConstructor, wrapMethod } from "../native/surface";

export type WorkerScriptFor = (url: string, module: boolean) => string | undefined;

export function patchBlobWorkerSource(
    targetWindow: Window,
    config: ClientConfig,
    getCurrentBaseUrl: () => URL,
): WorkerScriptFor {
    const w = targetWindow as unknown as { URL?: typeof URL; Blob?: typeof Blob };
    const sources = new WeakMap<object, { source: string; type: string }>();
    const byUrl = new Map<string, { source: string; type: string }>();
    const privateUrl = new Map<string, string>();
    const NativeBlob = wrapConstructor<typeof Blob>(targetWindow, "Blob", (Native, args, newTarget) => {
        const blob = Reflect.construct(Native, args, newTarget as typeof Blob);
        const [parts, options] = args as [unknown, BlobPropertyBag | undefined];
        const type = options?.type;
        if (isJsLikeType(type) && Array.isArray(parts) && parts.every((p) => typeof p === "string")) {
            sources.set(blob, { source: (parts as string[]).join(""), type: type! });
        }
        return blob;
    });
    const URLs = w.URL;
    if (!NativeBlob || !URLs) return () => undefined;
    const nativeCreate = wrapMethod<(o: object) => string>(URLs, "createObjectURL", (native, self, args) => {
        const url = Reflect.apply(native, self, args) as string;
        const src = sources.get(args[0]);
        if (src) byUrl.set(url, src);
        return url;
    });
    wrapMethod<(u: string) => void>(URLs, "revokeObjectURL", (native, self, args) => {
        byUrl.delete(String(args[0]));
        return Reflect.apply(native, self, args) as void;
    });
    return (url, module) => {
        const src = byUrl.get(url);
        if (!src || !nativeCreate) return undefined;
        const key = `${module ? "m" : "c"} ${url}`;
        let priv = privateUrl.get(key);
        if (!priv) {
            const body = buildWorkerPreamble(config, getCurrentBaseUrl().href, module) +
                rewriteJsSource(src.source, defaultJsRewriteOptions());
            priv = Reflect.apply(nativeCreate, URLs, [new NativeBlob([body], { type: src.type })]) as string;
            privateUrl.set(key, priv);
        }
        return priv;
    };
}

function isJsLikeType(type: string | undefined): boolean {
    if (!type) return false;
    const t = type.toLowerCase();
    return t.includes("javascript") || t.includes("ecmascript");
}

/**
 * A synchronous `importScripts()` call loads the full rewriter.js bundle
 * (including this worker's own `$rewriter_init_worker`, see rewriter.ts and
 * runtime/worker-bootstrap.ts) into the worker's scope before any of its own
 * (rewritten) code runs. importScripts is classic-worker-only and
 * synchronous/blocking — module workers (`{type: "module"}`) don't support
 * it, which is a known limitation: a module-worker's own fetch/XHR calls
 * won't get proxified by this path.
 */
function buildWorkerPreamble(config: ClientConfig, hrefAtCreation: string, module: boolean): string {
    const rewriterJsUrl = config.apiBaseURL + config.source;
    // A module worker has no importScripts and evaluates its imports first:
    // the server's init module (Go server.WorkerInitPath) runs the same
    // preamble as its first import.
    if (module) {
        return `import ${JSON.stringify(`${config.apiBaseURL}/cyrano-worker-init.js?u=${encodeURIComponent(hrefAtCreation)}`)};\n`;
    }
    return (
        `importScripts(${JSON.stringify(rewriterJsUrl)});` +
        `self.$rewriter=self.$rewriter_init_worker(${JSON.stringify(config)},${JSON.stringify(hrefAtCreation)});` +
        `self.$__crn_key__=null;\n`
    );
}
