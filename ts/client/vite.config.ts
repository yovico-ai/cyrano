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

// Stand-ins V8 prints as natives (src/native/padded.ts): a method whose
// body is `return body(this, args, "__crn_pad__")` gets a comment of 66000
// characters between its name and its parameters — V8 then shows
// "function NAME() { [native code] }" for it, in its messages too.
function padNatives(): Plugin {
    const gap = `/*${" ".repeat(66000)}*/`;
    return {
        name: "cyrano-pad-natives",
        // After every renderChunk (Vite's own esbuild pass strips comments).
        generateBundle(_options, bundle) {
            let n = 0;
            for (const chunk of Object.values(bundle)) {
                if (chunk.type !== "chunk") continue;
                chunk.code = chunk.code.replace(/(\b[A-Za-z_$][\w$]*)\(\.\.\.args\) \{(\s*)return body\(this, args, "__crn_pad__"\);/g,
                    (_m, name: string, ws: string) => { n++; return `${name} ${gap} (...args) {${ws}return body(this, args);`; });
            }
            if (n === 0) this.error("no padded native found (src/native/padded.ts)");
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
    plugins: [savedBuiltins(), padNatives()],
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
