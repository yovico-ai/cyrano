// Prints the reference rewriter's edits for each script given, as
// <file>.edits.json next to it: { ok, edits: [[bytePos, byteDel, ins], …] }.
// The Go recognizer is compared against these (go: TestSplice_Corpus).
//
//   npx vite-node tools/js-edits.ts -- dir/*.js

import { readFileSync, writeFileSync } from "node:fs";
import { defaultJsRewriteOptions, jsEdits } from "../src/js/rewriter";

const opts = {
    ...defaultJsRewriteOptions(),
    baseUrl: "https://corpus.example/dir/script.js",
    proxify: (s: string, base: string): string => (/^(\.{0,2}\/|https?:)/.test(s) ? "https://proxy.example/cyrano/" + new URL(s, base).href : s),
};

for (const file of process.argv.slice(2).filter((a) => a.endsWith(".js"))) {
    const src = readFileSync(file, "utf8");
    const edits = jsEdits(src, opts);
    let out: unknown = { ok: false };
    if (edits) {
        // UTF-16 offsets → UTF-8 byte offsets.
        const points = [...new Set(edits.flatMap((e) => [e.pos, e.pos + e.del]))].sort((a, b) => a - b);
        const bytes = new Map<number, number>();
        let at = 0;
        let n = 0;
        for (const p of points) {
            n += Buffer.byteLength(src.slice(at, p));
            at = p;
            bytes.set(p, n);
        }
        out = { ok: true, edits: edits.map((e) => [bytes.get(e.pos), bytes.get(e.pos + e.del)! - bytes.get(e.pos)!, e.ins]) };
    }
    writeFileSync(file + ".edits.json", JSON.stringify(out));
}
