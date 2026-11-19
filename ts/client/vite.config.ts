import { defineConfig, type Plugin } from "vite";
import { resolve } from "node:path";

// Bundled third-party code calls the built-ins it calls; a page can have
// replaced them (mountaineers.org's Plone bundle made startsWith a RegExp,
// and "[" threw). tldts (the public-suffix list, run on every cookie) is
// routed to the copies saved at load (src/native/intrinsics.ts). Acorn
// calls none of the methods polyfills replace.
const intrinsics = resolve(__dirname, "src/native/intrinsics.ts");
function savedBuiltins(): Plugin {
    return {
        name: "cyrano-saved-builtins",
        transform(code, id) {
            if (!/node_modules[\\/]tldts/.test(id)) return null;
            if (!/\.(startsWith|endsWith)\(/.test(code)) return null;
            const out = code
                .replace(/\b([A-Za-z_$][\w$]*)\.startsWith\(/g, "__crn_sStarts($1, ")
                .replace(/\b([A-Za-z_$][\w$]*)\.endsWith\(/g, "__crn_sEnds($1, ");
            if (/\.(startsWith|endsWith)\(/.test(out)) this.error(`unrewritten startsWith/endsWith in ${id}`);
            return { code: `import { sStarts as __crn_sStarts, sEnds as __crn_sEnds } from ${JSON.stringify(intrinsics)};\n${out}`, map: null };
        },
    };
}

// Emits one IIFE-wrapped script per entry, written directly into the shared
// asset root at <repo>/go/assets/client/. That directory is served as the
// static root by the current Node.js server (via proxy/handler.js) and will
// remain the static root once the Go server takes over.
//
// IIFE format avoids any module-loader assumptions on the page side; the script
// runs immediately on tag load, attaches `window.$rewriter_init`, and that's it.
export default defineConfig({
    plugins: [savedBuiltins()],
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
