// Playwright orchestration: navigate a persistent page to a target (directly
// or via the proxy), capture a PageSnapshot, and release listeners.
// The caller owns the Page lifecycle; this module never creates or closes pages.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { errors as pwErrors, type ConsoleMessage, type Page, type Request, type Response } from "playwright";
import type { ConsoleError, NetworkRequestSummary, PageSnapshot } from "./types.js";

const NAV_TIMEOUT_MS = 35_000;

export interface SnapshotOptions {
    target: string;
    proxyOrigin: string | null; // e.g. "http://localhost:9081" — null for direct fetch
    extraQuery?: string;        // tacked onto the proxified URL (e.g. "doc=1")
    runDir: string;             // absolute directory to write the captured HTML into
    label: string;              // file basename without extension — "direct" or "proxied"
}

/**
 * Navigates `page` to `target` (directly or through the proxy) and returns a
 * snapshot. Attaches event listeners before navigation and removes them in the
 * finally block so the page is clean for the next run.
 */
export async function captureSnapshot(
    page: Page,
    opts: SnapshotOptions,
): Promise<PageSnapshot> {
    const consoleErrors: ConsoleError[] = [];
    const requests: NetworkRequestSummary[] = [];
    const proxyHostname = opts.proxyOrigin ? new URL(opts.proxyOrigin).hostname : null;
    const leakHosts = new Set<string>();

    const onConsole = (msg: ConsoleMessage) => {
        if (msg.type() === "error") {
            consoleErrors.push({ source: "console", message: msg.text() });
        }
    };
    const onPageError = (err: Error) => {
        const entry: ConsoleError = { source: "pageerror", message: err.message || String(err) };
        if (err.stack) entry.stack = err.stack;
        consoleErrors.push(entry);
    };
    const onRequestFinished = (req: Request) => {
        const reqUrl = req.url();
        requests.push({ url: reqUrl, method: req.method(), status: 0, resourceType: req.resourceType() });
        void req.response()
            .then((r: Response | null) => {
                const s = r?.status() ?? 0;
                const entry = requests[requests.length - 1];
                if (entry && entry.url === reqUrl) entry.status = s;
            })
            .catch(() => {});
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
    };

    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    page.on("requestfinished", onRequestFinished);

    try {
        const visitURL = opts.proxyOrigin
            ? buildProxiedURL(opts.proxyOrigin, opts.target, opts.extraQuery)
            : opts.target;

        let resp: Response | null = null;
        try {
            resp = await page.goto(visitURL, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
        } catch (e) {
            // Ad-heavy pages frequently stall on third-party resources and
            // never fire the "load" event. Capture whatever landed rather
            // than discarding the run entirely.
            if (!(e instanceof pwErrors.TimeoutError)) throw e;
        }
        const statusCode = resp?.status() ?? 0;
        const finalUrl = page.url();
        const title = await page.title();

        const dom = await page.evaluate(domExtractor);

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
        page.off("console", onConsole);
        page.off("pageerror", onPageError);
        page.off("requestfinished", onRequestFinished);
    }
}

function buildProxiedURL(proxyOrigin: string, target: string, extraQuery?: string): string {
    const u = new URL(target);
    const scheme = u.protocol.slice(0, -1); // strip trailing ":"
    let path = "/cyrano/" + scheme + "/" + u.host + (u.pathname || "/");
    const qParts: string[] = [];
    if (u.search) qParts.push(u.search.slice(1));
    if (extraQuery) qParts.push(extraQuery);
    if (qParts.length) path += "?" + qParts.join("&");
    return proxyOrigin + path;
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

    const IAB_AD_SIZES = [
        [728,  90], [970,  90], [970, 250],
        [300, 250], [336, 280], [250, 250], [200, 200],
        [160, 600], [120, 600], [300, 600],
        [320,  50], [320, 100], [468,  60], [234,  60], [120, 240],
    ];

    const MARK = "data-bugminer-adsize";
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
        const r = el.getBoundingClientRect();
        if (IAB_AD_SIZES.some((s) => Math.abs(r.width - s[0]!) <= 2 && Math.abs(r.height - s[1]!) <= 2)) {
            (el as HTMLElement).setAttribute(MARK, "1");
        }
    }

    const clone = document.body.cloneNode(true) as HTMLElement;

    for (const sel of AD_SELECTORS) {
        clone.querySelectorAll(sel).forEach((el) => el.remove());
    }
    clone.querySelectorAll(`[${MARK}]`).forEach((el) => el.remove());

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
