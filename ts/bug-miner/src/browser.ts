// Playwright orchestration: open a target page either directly or via the
// proxy, capture a PageSnapshot, and tear down. The two paths share the
// same capture machinery so direct vs proxied snapshots are apples-to-apples.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, ConsoleMessage, Request, Response } from "playwright";
import type { ConsoleError, NetworkRequestSummary, PageSnapshot } from "./types.js";

const NAV_TIMEOUT_MS = 35_000;

/**
 * URL-safe base64 (no padding) — same alphabet as the Go b64u helper and
 * the TS client's b64uEncode. Inlined to avoid coupling bug-miner to the
 * client package import path.
 */
function b64uEncode(input: string): string {
    return Buffer.from(input, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

export interface SnapshotOptions {
    target: string;
    proxyOrigin: string | null; // e.g. "http://localhost:9081" — null for direct fetch
    userAgent: string;          // overrides Playwright's default UA on both sides
    extraQuery?: string;        // tacked onto the proxified URL (e.g. "doc=1")
    runDir: string;             // absolute directory to write the captured HTML into
    label: string;              // file basename without extension — "direct" or "proxied"
}

/**
 * Renders `target` (directly or through the proxy) and returns a snapshot.
 * Wraps the page-side instrumentation: console errors, network requests,
 * and proxy-leak detection (any request whose URL host is not the proxy
 * origin when running in proxied mode).
 */
export async function captureSnapshot(
    browser: Browser,
    opts: SnapshotOptions,
): Promise<PageSnapshot> {
    const ctx = await browser.newContext({
        ignoreHTTPSErrors: true,
        userAgent: opts.userAgent,
    });

    const consoleErrors: ConsoleError[] = [];
    const requests: NetworkRequestSummary[] = [];
    const proxyHostname = opts.proxyOrigin ? new URL(opts.proxyOrigin).hostname : null;
    const leakHosts = new Set<string>();

    try {
        const page = await ctx.newPage();

        page.on("console", (msg: ConsoleMessage) => {
            if (msg.type() === "error") {
                consoleErrors.push({ source: "console", message: msg.text() });
            }
        });
        page.on("pageerror", (err) => {
            // pageerror gives us a real Error with stack — way more useful for
            // pinning down a JS-rewriter regression than the bare message.
            const entry: ConsoleError = { source: "pageerror", message: err.message || String(err) };
            if (err.stack) entry.stack = err.stack;
            consoleErrors.push(entry);
        });
        page.on("requestfinished", (req: Request) => {
            const reqUrl = req.url();
            const status = req.response().then((r: Response | null) => r?.status() ?? 0);
            requests.push({ url: reqUrl, method: req.method(), status: 0, resourceType: req.resourceType() });
            // Best-effort fill of status — fire-and-forget; if the run ends
            // before this resolves the entry just keeps status: 0.
            void status.then((s) => {
                const entry = requests[requests.length - 1];
                if (entry && entry.url === reqUrl) entry.status = s;
            });
            // Proxy-leak detection: every request from a proxified page
            // should be on the proxy origin (we may relax this for
            // data:/blob: schemes which are inherently local).
            if (proxyHostname) {
                try {
                    const u = new URL(reqUrl);
                    if (
                        (u.protocol === "http:" || u.protocol === "https:") &&
                        u.hostname !== proxyHostname
                    ) {
                        leakHosts.add(u.hostname);
                    }
                } catch {
                    // ignore unparseable
                }
            }
        });

        const visitURL = opts.proxyOrigin
            ? buildProxiedURL(opts.proxyOrigin, opts.target, opts.extraQuery)
            : opts.target;

        const resp = await page.goto(visitURL, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
        const statusCode = resp?.status() ?? 0;
        const finalUrl = page.url();
        const title = await page.title();

        // DOM extraction — runs in the page context, post ad-filter.
        const dom = await page.evaluate(domExtractor);

        // Save the live, post-execution DOM as it stood when we measured it.
        // This is the artifact a future Claude session will diff against to
        // explain a "broken" verdict — not the rewriter's pre-execution
        // output, but what the browser actually rendered.
        const htmlFile = `${opts.label}.html`;
        const html = await page.content();
        writeFileSync(resolve(opts.runDir, htmlFile), html, "utf8");

        return {
            finalUrl,
            statusCode,
            title,
            visibleTextLength: dom.visibleTextLength,
            headings: dom.headings,
            linkCount: dom.linkCount,
            imageCount: dom.imageCount,
            consoleErrors,
            networkRequests: requests,
            proxyLeakHosts: [...leakHosts].sort(),
            htmlFile,
        };
    } finally {
        await ctx.close();
    }
}

function buildProxiedURL(proxyOrigin: string, target: string, extraQuery?: string): string {
    const enc = b64uEncode(target);
    const q = extraQuery ? `&${extraQuery}` : "";
    return `${proxyOrigin}/?goto=${enc}${q}`;
}

/**
 * Runs in the browser context. Pulls signals after stripping ad slots so
 * the comparison ignores noise that's expected to differ between direct
 * and proxied loads (third-party ad networks behave differently when the
 * page is loaded from `localhost:9081` vs the actual origin).
 *
 * Two removal passes:
 *  1. Selector-based — known ad network iframes, id/class/data-attr patterns.
 *  2. Size-based — elements whose rendered dimensions match IAB standard ad
 *     sizes. Must happen on the live DOM (where layout exists); we mark them
 *     with a temp attribute, clone, then remove + unmark.
 */
function domExtractor(): {
    visibleTextLength: number;
    headings: string[];
    linkCount: number;
    imageCount: number;
} {
    const AD_SELECTORS = [
        // iframe ad networks
        'iframe[src*="googlesyndication"]',
        'iframe[src*="doubleclick"]',
        'iframe[src*="adservice"]',
        'iframe[src*="adnxs"]',
        'iframe[src*="amazon-adsystem"]',
        'iframe[src*="adsafeprotected"]',
        'iframe[src*="taboola"]',
        'iframe[src*="outbrain"]',
        'iframe[src*="rubiconproject"]',
        'iframe[src*="criteo"]',
        // common ad-slot id/class shapes
        '[id^="google_ads"]',
        '[id^="div-gpt-ad"]',
        '[id^="ad_"], [id$="_ad"]',
        '[id*="-ad-"]',
        '[class*="ad-slot"]',
        '[class*="banner-ad"]',
        '[class*="adsbygoogle"]',
        '[data-ad-slot]',
        '[data-ad-client]',
        '[aria-label*="dvertisement" i]',
        // "Sponsored" cards (common newsroom/blog shape)
        '[data-sponsored]',
        '.sponsored',
    ];

    // IAB standard ad sizes [width, height] in CSS pixels, ±2px tolerance.
    // Defined as a plain array literal — no named inner function — so that
    // esbuild/tsx does not emit __name() helper calls inside the serialized
    // function body (which would be undefined in the browser context).
    const IAB_AD_SIZES = [
        [728,  90], [970,  90], [970, 250],
        [300, 250], [336, 280], [250, 250], [200, 200],
        [160, 600], [120, 600], [300, 600],
        [320,  50], [320, 100], [468,  60], [234,  60], [120, 240],
    ];

    // Mark ad-sized elements on the live DOM so the clone inherits the flag.
    const MARK = "data-bugminer-adsize";
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
        const r = el.getBoundingClientRect();
        if (IAB_AD_SIZES.some((s) => Math.abs(r.width - s[0]!) <= 2 && Math.abs(r.height - s[1]!) <= 2)) {
            (el as HTMLElement).setAttribute(MARK, "1");
        }
    }

    // Clone-and-prune so we don't mutate the live page.
    const clone = document.body.cloneNode(true) as HTMLElement;

    // Remove by selector.
    for (const sel of AD_SELECTORS) {
        clone.querySelectorAll(sel).forEach((el) => el.remove());
    }
    // Remove by size mark.
    clone.querySelectorAll(`[${MARK}]`).forEach((el) => el.remove());

    // Clean the mark off the live DOM.
    document.body.querySelectorAll(`[${MARK}]`).forEach((el) =>
        (el as HTMLElement).removeAttribute(MARK),
    );

    const headings = Array.from(clone.querySelectorAll("h1,h2,h3,h4,h5,h6"))
        .map((h) => (h.textContent ?? "").trim())
        .filter((s) => s.length > 0);
    return {
        visibleTextLength: (clone.textContent ?? "").trim().length,
        headings,
        linkCount: clone.querySelectorAll("a[href]").length,
        imageCount: clone.querySelectorAll("img").length,
    };
}
