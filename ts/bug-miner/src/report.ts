// Output layout:
//
//   reports/
//     <session>/
//       summary.md                  one row per run, verdicts + targets
//       <runid>-<query-slug>/
//         run.json                  signals, URLs, console errors w/ stacks
//         direct.html               post-execution DOM (no proxy)
//         proxied.html              post-execution DOM (through rewriter)
//
// run.json + the two HTML files are everything a Claude Code session needs
// to investigate a failure: the URL it tried, what the browser rendered on
// each side, and the JS errors it hit.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { MiningRun } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = resolve(__dirname, "../reports");

/** Deletes all session directories under reports/. */
export function cleanReports(): void {
    rmSync(REPORTS_DIR, { recursive: true, force: true });
    mkdirSync(REPORTS_DIR, { recursive: true });
}

export function ensureSessionDir(sessionTag: string): string {
    const dir = resolve(REPORTS_DIR, sessionTag);
    mkdirSync(dir, { recursive: true });
    return dir;
}

/** Creates the per-run directory that captureSnapshot will write HTML into. */
export function ensureRunDir(sessionTag: string, runIndex: number, query: string): string {
    const slug = query.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const id = String(runIndex + 1).padStart(3, "0");
    const dir = resolve(ensureSessionDir(sessionTag), `${id}-${slug}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

export function writeRunJSON(run: MiningRun, runDir: string): string {
    const path = resolve(runDir, "run.json");
    writeFileSync(path, JSON.stringify(run, null, 2), "utf8");
    return path;
}

export function writeSessionSummary(runs: MiningRun[], sessionTag: string): string {
    const dir = ensureSessionDir(sessionTag);
    const path = resolve(dir, "summary.md");
    writeFileSync(path, renderMarkdown(runs, sessionTag), "utf8");
    return path;
}

function renderMarkdown(runs: MiningRun[], sessionTag: string): string {
    const counts = { ok: 0, suspicious: 0, broken: 0, error: 0 };
    for (const r of runs) {
        if (!r.diff) counts.error++;
        else counts[r.diff.verdict]++;
    }

    const lines: string[] = [];
    lines.push(`# Bug-miner session ${sessionTag}`);
    lines.push("");
    lines.push(`**Runs**: ${runs.length}  `);
    lines.push(`**Verdicts**: ok=${counts.ok}, suspicious=${counts.suspicious}, broken=${counts.broken}, error=${counts.error}`);
    lines.push("");
    lines.push("| # | query | target | verdict | text-ratio | leaks | console-errs | notes |");
    lines.push("|---|---|---|---|---|---|---|---|");
    runs.forEach((r, i) => {
        const target = r.target ? truncate(r.target, 60) : "(no hit)";
        const verdict = r.diff?.verdict ?? "error";
        const textRatio = r.diff ? r.diff.visibleTextLengthRatio.toFixed(2) : "—";
        const leaks = r.diff?.proxyLeakCount ?? "—";
        const errs = r.diff?.proxiedConsoleErrorCount ?? "—";
        const notes: string[] = [];
        if ("error" in r.direct) notes.push(`direct: ${r.direct.error}`);
        if ("error" in r.proxied) notes.push(`proxied: ${r.proxied.error}`);
        if (r.diff && r.diff.headingsOnlyInDirect.length > 0) {
            notes.push(`missing ${r.diff.headingsOnlyInDirect.length} heading(s)`);
        }
        lines.push(
            `| ${i + 1} | \`${r.query}\` | ${target} | **${verdict}** | ${textRatio} | ${leaks} | ${errs} | ${notes.join("; ")} |`,
        );
    });
    lines.push("");
    return lines.join("\n");
}

function truncate(s: string, n: number): string {
    return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
