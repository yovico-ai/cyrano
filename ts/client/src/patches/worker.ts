// new Worker(url, options) and new SharedWorker(url, options), as page code
// sees them natively (see websocket.ts). The script URL is proxified, or —
// for an object URL of a JS Blob the page made — replaced by a private
// object URL holding the worker runtime and the rewritten source
// (blob-worker-source.ts); the page's own Blob and URL are untouched.

import { wrapConstructor } from "../native/surface";
import type { WorkerScriptFor } from "./blob-worker-source";

export function patchWorker(
    targetWindow: Window,
    rewriteOne: (url: string) => string,
    workerScriptFor: WorkerScriptFor = () => undefined,
): void {
    for (const name of ["Worker", "SharedWorker"] as const) {
        wrapConstructor<typeof Worker>(targetWindow, name, (Native, args, newTarget) => {
            if (!args.length) return Reflect.construct(Native, args, newTarget as typeof Worker);
            const url = String(args[0]);
            const opts = args[1] as { type?: unknown } | string | undefined;
            const module = typeof opts === "object" && opts !== null && opts.type === "module";
            return Reflect.construct(Native, [workerScriptFor(url, module) ?? rewriteOne(url), ...args.slice(1)], newTarget as typeof Worker);
        });
    }
}
