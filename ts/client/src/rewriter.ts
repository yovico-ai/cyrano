// Browser-side runtime entry — the file Vite bundles into rewriter.js.
//
// The server-side HTML rewriter injects a bootstrap snippet roughly:
//
//   <script src="/rewriter.js"></script>
//   <script>
//     window.$rewriter = window.$rewriter_init(window, {...config...}).inject();
//   </script>
//
// This same bundle is also loaded a second way: patches/blob-worker-source.ts
// prepends a synchronous `importScripts("<rewriter.js URL>")` call to a
// Worker's own (rewritten) source, so that a Worker's isolated global scope
// gets its own working `$rewriter` too — see runtime/worker-bootstrap.ts.
// `importScripts` runs this file inside `self` (a WorkerGlobalScope), where
// `window` doesn't exist — so the publish step below targets `globalThis`
// rather than assuming `window`, and it's a no-op if it can't find a place to
// attach (should never happen in a real browser or worker).

import { init } from "./runtime/bootstrap";
import { initWorker } from "./runtime/worker-bootstrap";

declare global {
    interface Window {
        $rewriter_init?: typeof init;
        $rewriter_init_worker?: typeof initWorker;
    }
}

(globalThis as unknown as Window).$rewriter_init = init;
(globalThis as unknown as Window).$rewriter_init_worker = initWorker;
