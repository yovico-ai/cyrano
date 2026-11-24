// new Worker(url, options) and new SharedWorker(url, options), as page code
// sees them natively (see websocket.ts). The script URL is proxified, or —
// for an object URL of a JS Blob the page made — replaced by a private
// object URL holding the worker runtime and the rewritten source
// (blob-worker-source.ts); the page's own Blob and URL are untouched.

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
): void {
    for (const name of ["Worker", "SharedWorker"] as const) {
        wrapConstructor<typeof Worker>(targetWindow, name, (Native, args, newTarget) => {
            if (!args.length) return nR.construct(Native, args, newTarget as typeof Worker);
            const url = String(args[0]);
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
