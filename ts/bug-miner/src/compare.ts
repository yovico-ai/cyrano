import type { DiffSummary, PageSnapshot } from "./types.js";

/**
 * Diffs two snapshots and returns a verdict.
 *
 * "ok"         — proxied side is essentially the same as direct
 * "suspicious" — within tolerance but worth a human look (some signal off)
 * "broken"     — clear regression (proxy leak, big content gap, console errors)
 */
export function diff(direct: PageSnapshot, proxied: PageSnapshot): DiffSummary {
    const headingsEqual = arraysEqual(direct.headings, proxied.headings);
    const directHeadings = new Set(direct.headings);
    const proxiedHeadings = new Set(proxied.headings);

    const visibleTextLengthRatio = ratio(direct.visibleTextLength, proxied.visibleTextLength);
    const linkCountRatio = ratio(direct.linkCount, proxied.linkCount);
    const imageCountRatio = ratio(direct.imageCount, proxied.imageCount);

    const summary: DiffSummary = {
        titleEqual: direct.title === proxied.title,
        headingsEqual,
        visibleTextLengthRatio,
        linkCountRatio,
        imageCountRatio,
        headingsOnlyInDirect: [...directHeadings].filter((h) => !proxiedHeadings.has(h)),
        headingsOnlyInProxied: [...proxiedHeadings].filter((h) => !directHeadings.has(h)),
        proxiedConsoleErrorCount: proxied.consoleErrors.length,
        proxyLeakCount: proxied.proxyLeakHosts.length,
        verdict: "ok",
    };

    summary.verdict = verdict(summary);
    return summary;
}

/** ratio of a/b clamped to [0, 1] (always returns proxied/direct). a=direct, b=proxied. */
function ratio(direct: number, proxied: number): number {
    if (direct === 0 && proxied === 0) return 1;
    if (direct === 0) return 0;
    return Math.min(proxied / direct, 1.0);
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Verdict heuristics. Tuned conservatively — better to flag false positives
 * for a human eye than to silently miss rewriter regressions.
 *
 * "broken":
 *   - proxy leak (any direct request from a proxified page)
 *   - lost > 50% of visible text
 *   - lost > 75% of headings
 *   - 5+ console errors on the proxied side that weren't expected
 *
 * "suspicious":
 *   - 10-50% visible-text discrepancy
 *   - any heading present in direct but missing in proxied
 *   - any console errors at all
 *   - link or image count ratios < 0.7
 */
function verdict(d: DiffSummary): "ok" | "suspicious" | "broken" {
    if (d.proxyLeakCount > 0) return "broken";
    if (d.visibleTextLengthRatio < 0.5) return "broken";
    if (d.proxiedConsoleErrorCount >= 5) return "broken";
    if (d.headingsOnlyInDirect.length > 0 && d.headingsOnlyInProxied.length === 0) {
        const lostFraction = d.headingsOnlyInDirect.length /
            (d.headingsOnlyInDirect.length + d.headingsOnlyInProxied.length + 1);
        if (lostFraction > 0.75) return "broken";
    }

    if (d.visibleTextLengthRatio < 0.9) return "suspicious";
    if (d.linkCountRatio < 0.7 || d.imageCountRatio < 0.7) return "suspicious";
    if (d.headingsOnlyInDirect.length > 0) return "suspicious";
    if (d.proxiedConsoleErrorCount > 0) return "suspicious";

    return "ok";
}
