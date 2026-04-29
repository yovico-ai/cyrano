import { defineConfig } from "vite";
import { resolve } from "node:path";

// Emits one IIFE-wrapped script per entry, written directly into the shared
// asset root at <repo>/go/assets/client/. That directory is served as the
// static root by the current Node.js server (via proxy/handler.js) and will
// remain the static root once the Go server takes over.
//
// IIFE format avoids any module-loader assumptions on the page side; the script
// runs immediately on tag load, attaches `window.$rewriter_init`, and that's it.
export default defineConfig({
    build: {
        target: "es2020",
        outDir: resolve(__dirname, "../../go/assets/client"),
        emptyOutDir: false, // other assets in the output dir shouldn't be wiped on partial builds
        minify: false,      // keep readable until we have something to optimize
        sourcemap: true,
        rollupOptions: {
            input: {
                rewriter: resolve(__dirname, "src/rewriter.ts"),
            },
            output: {
                format: "iife",
                entryFileNames: "[name].js",
                // Inline any code-split chunks so the page only needs the one <script>.
                inlineDynamicImports: true,
            },
        },
    },
});
