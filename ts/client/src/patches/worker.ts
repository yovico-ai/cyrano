// new Worker(url, options) and new SharedWorker(url, options), as page code
// sees them natively (see websocket.ts). The script URL is proxified, or —
// for an object URL of a JS Blob the page made — replaced by a private
// object URL holding the worker runtime and the rewritten source
// (blob-worker-source.ts); the page's own Blob and URL are untouched.

import { stacked } from "../native/stacked";
import { nR } from "../native/intrinsics";
import { isTrustedValue, trusted } from "../native/trusted";
import { wrapConstructor } from "../native/surface";
import type { WorkerScriptFor } from "./blob-worker-source";
import { unwrapProxiedUrl, type Dest } from "../url/containment";
import type { ClientConfig } from "../config";

export function patchWorker(
    targetWindow: Window,
    rewriteOne: ((url: string) => string) & { withMark?: (url: string, policy: string | null, dest: Dest | null) => string },
    workerScriptFor: WorkerScriptFor = () => undefined,
    config?: ClientConfig,
    base?: () => URL,
): void {
    const DE = (targetWindow as unknown as { DOMException?: new (m: string, n: string) => Error }).DOMException;
    for (const name of ["Worker", "SharedWorker"] as const) {
        wrapConstructor<typeof Worker>(targetWindow, name, (Native, args, newTarget) => {
            if (!args.length || typeof args[0] === "symbol") return nR.construct(Native, args, newTarget as typeof Worker);
            const url = String(args[0]);
            // A script of another origin cannot be a worker: the native's
            // SecurityError, as directly (round I: through the proxy every
            // URL is same-origin, and it ran — libraries fall back to a
            // blob worker on that error).
            if (base && config && DE) {
                const refused = crossOriginWorker(url, base(), config);
                if (refused) throw stacked(new DE(`Failed to construct '${name}': Script at '${refused}' cannot be accessed from origin '${base().origin}'.`, "SecurityError"));
            }
            const opts = args[1] as { type?: unknown } | string | undefined;
            const module = typeof opts === "object" && opts !== null && opts.type === "module";
            // A module worker's URL says so (the server gives it the module
            // preamble: asked for same-origin, it cannot tell).
            // (The JS rules have proxified a URL in the source already — R10
            // does not see the options: it is marked again, from its target.)
            const script = workerScriptFor(url, module) ??
                (module && rewriteOne.withMark ? rewriteOne.withMark(config ? unwrapProxiedUrl(url, config) ?? url : url, null, "mjs") : rewriteOne(url));
            // A TrustedScriptURL (the page's, under Trusted Types) stays trusted.
            return nR.construct(Native, [isTrustedValue(args[0]) ? trusted(targetWindow, "ScriptURL", script) : script, ...args.slice(1)], newTarget as typeof Worker);
        });
    }
}

/**
 * The resolved URL of a worker script of another origin than `base`'s
 * (http(s) only: blob: and data: are the native's to judge), or null.
 */
export function crossOriginWorker(url: string, base: URL, config: ClientConfig): string | null {
    let u: URL;
    try { u = new URL(unwrapProxiedUrl(url, config) ?? url, base); } catch { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin === base.origin ? null : u.href;
}
