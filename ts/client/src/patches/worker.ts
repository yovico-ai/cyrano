// Patch the `Worker` and `SharedWorker` constructors so dynamic worker
// scripts go through the proxy.
//
// Two near-identical patches in one module because they share enough that
// keeping them together reads better than splitting. Each is no-op when the
// global is missing (older browsers / restrictive contexts).

import { getGlobal, setGlobal } from "./globals";

type WorkerCtor = new (url: string | URL, options?: WorkerOptions) => Worker;
type SharedWorkerCtor = new (
    url: string | URL,
    options?: string | WorkerOptions,
) => SharedWorker;

export function patchWorker(
    _targetWindow: Window,
    rewriteOne: (url: string) => string,
): void {
    patchPlainWorker(rewriteOne);
    patchSharedWorker(rewriteOne);
}

function patchPlainWorker(rewriteOne: (url: string) => string): void {
    const NativeWorker = getGlobal<WorkerCtor>("Worker");
    if (!NativeWorker) return;
    const Native = NativeWorker;

    function PatchedWorker(
        this: unknown,
        url: string | URL,
        options?: WorkerOptions,
    ): Worker {
        const rawUrl = typeof url === "string" ? url : url.href;
        return new Native(rewriteOne(rawUrl), options);
    }
    PatchedWorker.prototype = Native.prototype;

    setGlobal("Worker", PatchedWorker);
}

function patchSharedWorker(rewriteOne: (url: string) => string): void {
    const NativeSharedWorker = getGlobal<SharedWorkerCtor>("SharedWorker");
    if (!NativeSharedWorker) return;
    const Native = NativeSharedWorker;

    function PatchedSharedWorker(
        this: unknown,
        url: string | URL,
        options?: string | WorkerOptions,
    ): SharedWorker {
        const rawUrl = typeof url === "string" ? url : url.href;
        return new Native(rewriteOne(rawUrl), options);
    }
    PatchedSharedWorker.prototype = Native.prototype;

    setGlobal("SharedWorker", PatchedSharedWorker);
}
