// CLI entry. One run = one query, two snapshots, one diff, one JSON report.
// Loops until the requested run count is reached, writes a session summary.
//
// Three persistent tabs are opened at startup and reused across all runs:
//   Tab 1 — search: navigates search engines to find the target URL
//   Tab 2 — direct: loads the target URL as-is (no proxy)
//   Tab 3 — via proxy: loads the target through the cyrano proxy
//
//   tsx src/main.ts                                      # default: chrome, headed
//   tsx src/main.ts --runs 5
//   tsx src/main.ts --headless                           # no UI (CI / batch)
//   tsx src/main.ts --browser chromium                   # use Playwright's bundled chromium
//   tsx src/main.ts --user-agent "Mozilla/5.0 (...)"     # override UA on both sides
//   tsx src/main.ts --slow-mo 250                        # 250ms between actions, for visual debug
//   tsx src/main.ts --query "specific words to search"
//   tsx src/main.ts --proxy http://localhost:9080
//   tsx src/main.ts --clean                              # delete all previous reports, then run
//   tsx src/main.ts --clean --runs 0                     # delete reports only, no new run

import { parseArgs } from "node:util";
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from "playwright";
import { firstHit } from "./search.js";
import { captureSnapshot } from "./browser.js";
import { diff } from "./compare.js";
import { pickQuery } from "./words.js";
import { cleanReports, ensureRunDir, writeRunJSON, writeSessionSummary } from "./report.js";
import type { MiningRun, PageSnapshot } from "./types.js";

/**
 * Verify the proxy is reachable and serving rewriter.js with the correct
 * Content-Type. Fails fast with a clear message rather than letting every
 * run produce a wall of "$rewriter is not defined" errors.
 */
async function preflightCheck(proxyOrigin: string): Promise<void> {
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
    clean: boolean;
}

function parseCLI(): CLIOpts {
    const { values, positionals } = parseArgs({
        options: {
            runs:       { type: "string", default: "1" },
            proxy:      { type: "string", default: "http://localhost:9081" },
            query:      { type: "string" },
            headless:   { type: "boolean", default: false },
            browser:    { type: "string",  default: "chrome" },
            "user-agent": { type: "string", default: DEFAULT_UA },
            "slow-mo":  { type: "string",  default: "0" },
            clean:      { type: "boolean", default: false },
        },
        allowPositionals: true,
    });
    const positionalRuns = positionals[0] !== undefined && /^\d+$/.test(positionals[0])
        ? positionals[0]
        : null;
    const browser = values.browser === "chromium" ? "chromium" : "chrome";
    return {
        runs:    Math.max(0, parseInt(positionalRuns ?? values.runs ?? "1", 10)),
        proxy:   values.proxy ?? "http://localhost:9081",
        query:   values.query ?? null,
        headless: values.headless ?? false,
        browser,
        userAgent: values["user-agent"] ?? DEFAULT_UA,
        slowMo:  Math.max(0, parseInt(values["slow-mo"] ?? "0", 10)),
        clean:   values.clean ?? false,
    };
}

// Three persistent tabs shared across all runs in a session.
interface Session {
    searchPage: Page;
    directPage: Page;
    proxyPage: Page;
    ctx: BrowserContext;
}

async function createSession(browser: Browser, userAgent: string): Promise<Session> {
    const ctx = await browser.newContext({
        ignoreHTTPSErrors: true,
        userAgent,
    });
    const [searchPage, directPage, proxyPage] = await Promise.all([
        ctx.newPage(),
        ctx.newPage(),
        ctx.newPage(),
    ]);
    return { searchPage, directPage, proxyPage, ctx };
}

async function destroySession(session: Session): Promise<void> {
    try { await session.ctx.close(); } catch { /* already gone */ }
}

async function runOne(
    session: Session,
    query: string,
    proxyOrigin: string,
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
        target = await firstHit(session.searchPage, query);
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

    // Direct and proxied load in parallel — they use separate tabs.
    const [direct, proxied] = await Promise.allSettled([
        captureSnapshot(session.directPage, { target, proxyOrigin: null, runDir, label: "direct" }),
        captureSnapshot(session.proxyPage, { target, proxyOrigin, runDir, label: "proxied" }),
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

    if (opts.clean) {
        cleanReports();
        console.log("reports/ cleaned");
        if (opts.runs === 0) return;
    }

    const sessionTag = new Date().toISOString().replace(/[:.]/g, "-");
    console.log(`bug-miner session ${sessionTag}`);
    console.log(`  runs=${opts.runs}, proxy=${opts.proxy}, browser=${opts.browser}, headless=${opts.headless}`);
    if (opts.slowMo > 0) console.log(`  slow-mo=${opts.slowMo}ms`);

    if (opts.runs === 0) return;

    await preflightCheck(opts.proxy);

    const launch: LaunchOptions = {
        headless: opts.headless,
        slowMo: opts.slowMo,
    };
    if (opts.browser === "chrome") {
        launch.channel = "chrome";
    }

    let browser = await chromium.launch(launch);
    let session = await createSession(browser, opts.userAgent);
    const runs: MiningRun[] = [];

    const ensureSession = async (): Promise<Session> => {
        if (browser.isConnected()) return session;
        console.log("  [browser crashed — relaunching]");
        try { await browser.close(); } catch { /* already gone */ }
        browser = await chromium.launch(launch);
        session = await createSession(browser, opts.userAgent);
        return session;
    };

    try {
        for (let i = 0; i < opts.runs; i++) {
            const query = opts.query ?? pickQuery();
            console.log(`\n[${i + 1}/${opts.runs}] query: "${query}"`);

            const runDir = ensureRunDir(sessionTag, i, query);
            const s = await ensureSession();
            const run = await runOne(s, query, opts.proxy, runDir);
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
        await destroySession(session);
        try { await browser.close(); } catch { /* already gone */ }
    }

    const summaryPath = writeSessionSummary(runs, sessionTag);
    console.log(`\nsummary: ${summaryPath}`);
}

main().catch((err) => {
    console.error("bug-miner failed:", err);
    process.exit(1);
});
