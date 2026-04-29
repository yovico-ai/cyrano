// Browser-side runtime entry — the file Vite bundles into rewriter.js.
//
// The server-side HTML rewriter injects a bootstrap snippet roughly:
//
//   <script src="/rewriter.js"></script>
//   <script>
//     window.$rewriter = window.$rewriter_init(window, {...config...}).inject();
//   </script>
//
// All this entry does is publish `window.$rewriter_init`. Everything else
// lives under src/ and is reached through that one global.

import { init } from "./runtime/bootstrap";

declare global {
    interface Window {
        $rewriter_init?: typeof init;
    }
}

window.$rewriter_init = init;
