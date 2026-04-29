import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORDS_PATH = resolve(__dirname, "../words.txt");

let cached: string[] | null = null;

/** Load the 10k-word list once and cache it. Empty/comment lines are dropped. */
function load(): string[] {
    if (cached) return cached;
    const raw = readFileSync(WORDS_PATH, "utf8");
    const lines = raw.split(/\r?\n/);
    cached = [];
    for (const line of lines) {
        const w = line.trim();
        if (w.length >= 3 && !w.startsWith("#")) {
            cached.push(w);
        }
    }
    return cached;
}

/** Pick `n` distinct random words from the list. */
export function pickRandom(n: number): string[] {
    const list = load();
    if (n > list.length) {
        throw new Error(`requested ${n} words; list only has ${list.length}`);
    }
    const picked = new Set<number>();
    while (picked.size < n) {
        picked.add(Math.floor(Math.random() * list.length));
    }
    return [...picked].map((i) => {
        const w = list[i];
        if (w === undefined) throw new Error("unreachable: out-of-bounds index");
        return w;
    });
}

/** Convenience for the canonical 3-word query. */
export function pickQuery(): string {
    return pickRandom(3).join(" ");
}
