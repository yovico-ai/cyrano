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
// Any other worker script the page hands over as a blob: or data: URL — a
// Blob without a type (Permutive: `new Blob([code])`), one from a Response
// or binary parts, a data:application/javascript URL — is read back when
// the Worker is made (a synchronous read of the page's own URL, which is
// still valid then) and treated the same way.
//
// Known gap: the object URL's origin is the proxy's (blob:http://proxy/…)
// where natively it is the site's; translating blob: URLs is a follow-up.
import { SafeMap, SafeWeakMap, nR } from "../native/intrinsics";
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
    const sources = new SafeWeakMap<object, { source: string; type: string }>();
    const byUrl = new SafeMap<string, { source: string; type: string }>();
    const privateUrl = new SafeMap<string, string>();
    const NativeBlob = wrapConstructor<typeof Blob>(targetWindow, "Blob", (Native, args, newTarget) => {
        const blob = nR.construct(Native, args, newTarget as typeof Blob);
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
        const url = nR.apply(native, self, args) as string;
        const src = sources.get(args[0]);
        if (src) byUrl.set(url, src);
        return url;
    });
    wrapMethod<(u: string) => void>(URLs, "revokeObjectURL", (native, self, args) => {
        byUrl.delete(String(args[0]));
        return nR.apply(native, self, args) as void;
    });
    return (url, module) => {
        const src = byUrl.get(url) ?? readScript(targetWindow, url);
        if (!src || !nativeCreate) return undefined;
        const key = `${module ? "m" : "c"} ${url}`;
        let priv = privateUrl.get(key);
        if (!priv) {
            const body = buildWorkerPreamble(config, getCurrentBaseUrl().href, module) +
                rewriteJsSource(src.source, defaultJsRewriteOptions());
            priv = nR.apply(nativeCreate, URLs, [new NativeBlob([body], { type: src.type })]) as string;
            privateUrl.set(key, priv);
        }
        return priv;
    };
}

/**
 * The text behind a blob: or data: worker URL, read synchronously (the
 * Worker constructor is synchronous, and the page may revoke the URL right
 * after it). Undefined for any other URL or when it cannot be read.
 */
function readScript(targetWindow: Window, url: string): { source: string; type: string } | undefined {
    if (!/^(blob|data):/i.test(url)) return undefined;
    const XHR = (targetWindow as unknown as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
    if (!XHR) return undefined;
    try {
        const x = new XHR();
        x.open("GET", url, false);
        x.overrideMimeType("text/javascript; charset=utf-8");
        x.send();
        if (x.status !== 200 && x.status !== 0) return undefined;
        return { source: x.responseText, type: "text/javascript" };
    } catch {
        return undefined;
    }
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
    // Under Trusted Types (a blob worker has its creator's policy)
    // importScripts takes a TrustedScriptURL: made by the runtime's policy,
    // which the runtime is then handed (Go: server.workerPreamble).
    const url = JSON.stringify(rewriterJsUrl);
    return (
        `(function(p,i){try{p=self.trustedTypes.createPolicy(${JSON.stringify(config.tt ?? "")},` +
        `{createHTML:i,createScript:i,createScriptURL:i})}catch(e){p=null}` +
        `importScripts(p?p.createScriptURL(${url}):${url});` +
        `self.$rewriter=self.$rewriter_init_worker(${JSON.stringify(config)},${JSON.stringify(hrefAtCreation)},p);` +
        `self.$__crn_key__=null})(null,function(s){return s});\n`
    );
}
