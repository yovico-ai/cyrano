// Patches the global `Blob` constructor to rewrite JS-typed content before
// it can become a Worker's source.
//
// Anti-bot challenge scripts (Cloudflare's included) commonly run their
// fingerprinting logic in a Worker built like:
//
//   new Worker(URL.createObjectURL(new Blob([src], {type: "text/javascript"})))
//
// `patches/worker.ts` already proxifies the *URL argument* of `new Worker(...)`,
// but that's a no-op for `blob:` URLs (they aren't proxy-routable — the
// content is already in-memory) and doesn't help even for http(s) worker
// URLs, because nothing installs `$rewriter` inside the *worker's own* global
// scope: `window`-level prototype patches never apply there, a Worker is a
// separate JS realm. Per spec, a `blob:` worker's relative-path fetch/XHR
// calls resolve against the *creating page's origin* — the proxy's own
// origin here — which is exactly why un-rewritten worker fetches show up as
// bare, un-prefixed requests on the proxy's own listener instead of being
// routed to the upstream.
//
// The fix has to happen here, synchronously, at Blob-construction time:
// `new Worker(url)` must return synchronously, so there's no window to do an
// async fetch-then-rewrite-then-construct dance after the fact (and blob:
// URLs can only be read back asynchronously anyway). The Blob constructor,
// by contrast, receives the source as a plain string synchronously — so we
// rewrite it right there, before it's ever wrapped in a URL.
//
// Non-string parts (ArrayBuffer, TypedArray, nested Blob) are left untouched
// — we can't safely treat arbitrary binary content as JS source text.
import type { ClientConfig } from "../config";
import { getGlobal, setGlobal } from "./globals";
import { rewriteJsSource, defaultJsRewriteOptions } from "../js/rewriter";

type BlobCtor = new (parts?: BlobPart[], options?: BlobPropertyBag) => Blob;

export function patchBlobWorkerSource(
    config: ClientConfig,
    getCurrentBaseUrl: () => URL,
): void {
    const NativeBlob = getGlobal<BlobCtor>("Blob");
    if (!NativeBlob) return;
    const Native = NativeBlob;

    function PatchedBlob(
        this: unknown,
        parts?: BlobPart[],
        options?: BlobPropertyBag,
    ): Blob {
        if (isJsLikeType(options?.type) && parts && allStrings(parts)) {
            const source = (parts as string[]).join("");
            const rewritten = rewriteJsSource(source, defaultJsRewriteOptions());
            const preamble = buildWorkerPreamble(config, getCurrentBaseUrl().href);
            return new Native([preamble, rewritten], options);
        }
        return new Native(parts, options);
    }
    PatchedBlob.prototype = Native.prototype;

    setGlobal("Blob", PatchedBlob);
}

function isJsLikeType(type: string | undefined): boolean {
    if (!type) return false;
    const t = type.toLowerCase();
    return t.includes("javascript") || t.includes("ecmascript");
}

function allStrings(parts: BlobPart[]): parts is string[] {
    return parts.every((p) => typeof p === "string");
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
function buildWorkerPreamble(config: ClientConfig, hrefAtCreation: string): string {
    const rewriterJsUrl = config.apiBaseURL + config.source;
    return (
        `importScripts(${JSON.stringify(rewriterJsUrl)});` +
        `self.$rewriter=self.$rewriter_init_worker(${JSON.stringify(config)},${JSON.stringify(hrefAtCreation)});` +
        `self.$__crn_key__=null;\n`
    );
}
