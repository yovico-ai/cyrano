// CLI entry. One run = one query, two snapshots, one diff, one JSON report.
// Loops until the requested run count is reached, writes a session summary.
//
//   tsx src/main.ts                                      # default: chrome, headed
//   tsx src/main.ts --runs 5
//   tsx src/main.ts --headless                           # no UI (CI / batch)
//   tsx src/main.ts --browser chromium                   # use Playwright's bundled chromium
//   tsx src/main.ts --user-agent "Mozilla/5.0 (...)"     # override UA on both sides
//   tsx src/main.ts --slow-mo 250                        # 250ms between actions, for visual debug
//   tsx src/main.ts --query "specific words to search"
//   tsx src/main.ts --proxy http://localhost:9080

import { parseArgs } from "node:util";
import { chromium, type Browser, type LaunchOptions } from "playwright";
import { firstHit } from "./search.js";
import { captureSnapshot } from "./browser.js";
import { diff } from "./compare.js";
import { pickQuery } from "./words.js";
import { ensureRunDir, writeRunJSON, writeSessionSummary } from "./report.js";
import type { MiningRun, PageSnapshot } from "./types.js";

/**
 * Verify the proxy is reachable and serving rewriter.js with the correct
 * Content-Type. Fails fast with a clear message rather than letting every
 * run produce a wall of "$rewriter is not defined" errors.
 */
async function preflightCheck(proxyOrigin: string): Promise<void> {
    // 1. Proxy root must respond.
    let rootOk = false;
    try {
        const r = await fetch(`${proxyOrigin}/`, { signal: AbortSignal.timeout(5000) });
        rootOk = r.status < 500;
    } catch (e) {
        throw new Error(`proxy not reachable at ${proxyOrigin}: ${String(e)}`);
    }
    if (!rootOk) {
        throw new Error(`proxy at ${proxyOrigin}/ returned a 5xx — is it running?`);
    }

    // 2. rewriter.js must be served as JavaScript, not text/plain or 404.
    let jsRes: Response;
    try {
        jsRes = await fetch(`${proxyOrigin}/rewriter.js`, { signal: AbortSignal.timeout(5000) });
    } catch (e) {
        throw new Error(`could not fetch ${proxyOrigin}/rewriter.js: ${String(e)}`);
    }
    if (jsRes.status === 404) {
        throw new Error(
            `${proxyOrigin}/rewriter.js returned 404.\n` +
            `  The TS client bundle is missing. Run:\n` +
            `    cd ts/client && npm run build`,
        );
    }
    const ct = jsRes.headers.get("content-type") ?? "";
    if (!ct.includes("javascript") && !ct.includes("ecmascript")) {
        throw new Error(
            `${proxyOrigin}/rewriter.js served with wrong Content-Type: ${ct}\n` +
            `  Expected application/javascript. Rebuild the TS client:\n` +
            `    cd ts/client && npm run build`,
        );
    }
}

const DEFAULT_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type BrowserChannel = "chrome" | "chromium";

interface CLIOpts {
    runs: number;
    proxy: string;
    query: string | null;
    headless: boolean;
    browser: BrowserChannel;
    userAgent: string;
    slowMo: number;
}

function parseCLI(): CLIOpts {
    const { values, positionals } = parseArgs({
        options: {
            runs:       { type: "string", default: "1" },
            proxy:      { type: "string", default: "http://localhost:9081" },
            query:      { type: "string" },
            headless:   { type: "boolean", default: false },           // visible by default
            browser:    { type: "string",  default: "chrome" },        // real Chrome by default
            "user-agent": { type: "string", default: DEFAULT_UA },
            "slow-mo":  { type: "string",  default: "0" },
        },
        allowPositionals: true,
    });
    // Accept a bare number as a positional shorthand for --runs N.
    const positionalRuns = positionals[0] !== undefined && /^\d+$/.test(positionals[0])
        ? positionals[0]
        : null;
    const browser = values.browser === "chromium" ? "chromium" : "chrome";
    return {
        runs:    Math.max(1, parseInt(positionalRuns ?? values.runs ?? "1", 10)),
        proxy:   values.proxy ?? "http://localhost:9081",
        query:   values.query ?? null,
        headless: values.headless ?? false,
        browser,
        userAgent: values["user-agent"] ?? DEFAULT_UA,
        slowMo:  Math.max(0, parseInt(values["slow-mo"] ?? "0", 10)),
    };
}

async function runOne(
    browser: Browser,
    query: string,
    proxyOrigin: string,
    userAgent: string,
    runDir: string,
): Promise<MiningRun> {
    const timestamp = new Date().toISOString();
    const run: MiningRun = {
        timestamp,
        query,
        target: null,
        direct: { error: "not yet captured" },
        proxied: { error: "not yet captured" },
        diff: null,
    };

    let target: string | null = null;
    try {
        target = await firstHit(browser, query, userAgent);
    } catch (e) {
        run.direct = { error: `search failed: ${String(e)}` };
        run.proxied = { error: "search failed; no target" };
        return run;
    }
    run.target = target;
    if (!target) {
        run.direct = { error: "search returned no hit" };
        run.proxied = { error: "no target" };
        return run;
    }

    // Direct + proxied in parallel — they're independent contexts.
    const [direct, proxied] = await Promise.allSettled([
        captureSnapshot(browser, { target, proxyOrigin: null, userAgent, runDir, label: "direct" }),
        captureSnapshot(browser, { target, proxyOrigin, userAgent, extraQuery: "doc=1", runDir, label: "proxied" }),
    ]);

    run.direct  = direct.status  === "fulfilled" ? direct.value  : { error: String(direct.reason) };
    run.proxied = proxied.status === "fulfilled" ? proxied.value : { error: String(proxied.reason) };

    if ("statusCode" in run.direct && "statusCode" in run.proxied) {
        run.diff = diff(run.direct as PageSnapshot, run.proxied as PageSnapshot);
    }
    return run;
}

async function main() {
    const opts = parseCLI();
    const sessionTag = new Date().toISOString().replace(/[:.]/g, "-");
    console.log(`bug-miner session ${sessionTag}`);
    console.log(`  runs=${opts.runs}, proxy=${opts.proxy}, browser=${opts.browser}, headless=${opts.headless}`);
    if (opts.slowMo > 0) console.log(`  slow-mo=${opts.slowMo}ms`);

    await preflightCheck(opts.proxy);

    const launch: LaunchOptions = {
        headless: opts.headless,
        slowMo: opts.slowMo,
    };
    if (opts.browser === "chrome") {
        // System-installed Chrome (Playwright spawns it via the `chrome`
        // channel — google-chrome on Linux, /Applications/Google Chrome on macOS).
        // Falls back with a clear error if Chrome isn't installed.
        launch.channel = "chrome";
    }

    let browser = await chromium.launch(launch);
    const runs: MiningRun[] = [];

    const ensureBrowser = async (): Promise<typeof browser> => {
        if (browser.isConnected()) return browser;
        console.log("  [browser crashed — relaunching]");
        try { await browser.close(); } catch { /* already gone */ }
        browser = await chromium.launch(launch);
        return browser;
    };

    try {
        for (let i = 0; i < opts.runs; i++) {
            const query = opts.query ?? pickQuery();
            console.log(`\n[${i + 1}/${opts.runs}] query: "${query}"`);

            const runDir = ensureRunDir(sessionTag, i, query);
            const b = await ensureBrowser();
            const run = await runOne(b, query, opts.proxy, opts.userAgent, runDir);
            runs.push(run);

            const jsonPath = writeRunJSON(run, runDir);
            const verdict = run.diff?.verdict ?? "error";
            const target = run.target ?? "(no hit)";
            console.log(`  target:  ${target}`);
            console.log(`  verdict: ${verdict}`);
            if (run.diff) {
                console.log(`  text ratio:    ${run.diff.visibleTextLengthRatio.toFixed(2)}`);
                console.log(`  proxy leaks:   ${run.diff.proxyLeakCount}`);
                console.log(`  console errs:  ${run.diff.proxiedConsoleErrorCount}`);
            }
            console.log(`  → ${jsonPath}`);
        }
    } finally {
        try { await browser.close(); } catch { /* already gone */ }
    }

    const summaryPath = writeSessionSummary(runs, sessionTag);
    console.log(`\nsummary: ${summaryPath}`);
}

main().catch((err) => {
    console.error("bug-miner failed:", err);
    process.exit(1);
});
