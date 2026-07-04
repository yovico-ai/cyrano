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

// Remove our own injected <script> element from the DOM once it has executed.
// Everything it defines ($rewriter_init/_worker) lives on globalThis, so
// removing the element loses nothing — but it keeps document.scripts.length
// matching an un-proxied page. Anti-bot widgets (e.g. Cloudflare Turnstile)
// count document.scripts and treat an unexpected extra one as tampering, so
// any injected-and-left script inflates the fingerprint. Main-thread only:
// under importScripts in a Worker there is no document and no element to drop.
try {
    const doc = (globalThis as { document?: Document }).document;
    const self = doc?.currentScript;
    if (self && typeof self.remove === "function") self.remove();
} catch {
    /* non-fatal — leaving the element is only a cosmetic fingerprint cost */
}
