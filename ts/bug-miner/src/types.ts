// Shared types for the bug-miner. Kept minimal and JSON-serializable so the
// reports can round-trip through disk + tooling without custom serializers.

/** A single mining run — one search query, two browser sessions, one diff. */
export interface MiningRun {
    timestamp: string; // ISO 8601
    query: string; // the 3-word phrase
    target: string | null; // URL of the first search hit (null on search miss)

    direct: PageSnapshot | { error: string };
    proxied: PageSnapshot | { error: string };

    diff: DiffSummary | null; // null if either side errored
}

/** Distillation of a rendered page — enough to compare two captures structurally. */
export interface PageSnapshot {
    finalUrl: string; // after redirects
    statusCode: number;
    title: string;
    visibleTextLength: number;
    headings: string[]; // h1-h6 text, in document order
    linkCount: number; // anchor count after ad filter
    imageCount: number;
    consoleErrors: ConsoleError[];
    networkRequests: NetworkRequestSummary[];
    proxyLeakHosts: string[]; // proxied side only — request URLs that bypass the proxy
    htmlFile: string; // basename of the saved post-execution DOM (e.g. "proxied.html")
}

/** A single error from console.error or an uncaught page exception. */
export interface ConsoleError {
    source: "console" | "pageerror"; // console.error vs uncaught exception
    message: string;
    stack?: string; // present on pageerror; usually absent on console messages
}

/** Per-request summary for the network log. */
export interface NetworkRequestSummary {
    url: string;
    method: string;
    status: number; // 0 if no response
    resourceType: string;
}

/** Side-by-side comparison output. */
export interface DiffSummary {
    titleEqual: boolean;
    headingsEqual: boolean;
    visibleTextLengthRatio: number; // proxied / direct, 1.0 = identical
    linkCountRatio: number;
    imageCountRatio: number;
    headingsOnlyInDirect: string[];
    headingsOnlyInProxied: string[];
    proxiedConsoleErrorCount: number;
    proxyLeakCount: number; // > 0 → containment bug
    verdict: "ok" | "suspicious" | "broken";
}
