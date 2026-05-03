// Search front-end. Tries a small chain of engines; first non-empty result wins.
//
// Why not Google: heavy bot-detection, blocks Playwright instantly.
// Why not DuckDuckGo: HTML/lite endpoints rate-limit headless browsers
//                    aggressively (returns a 273-byte "email us" error).
//
// Order:
//   1. Yandex (ya.ru → yandex.ru) — diverse open-web results, no captcha
//   2. Bing                       — broad coverage, redirector URLs need unwrap
//   3. Wikipedia                  — last-resort; only encyclopedic targets
//
// We fall through engines on empty/error. Returns null only if every engine
// produces nothing for the query.

import type { Page } from "playwright";

interface Engine {
    name: string;
    url(query: string): string;
    selector: string;
    unwrap?(href: string): string | null;
}

const ENGINES: Engine[] = [
    {
        name: "yandex",
        url: (q) => `https://ya.ru/?q=${encodeURIComponent(q)}`,
        selector: `a[class*="Organic"][class*="Link_theme_normal"]`,
    },
    {
        name: "bing",
        url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
        selector: "li.b_algo h2 a",
        unwrap: unwrapBing,
    },
    {
        name: "wikipedia",
        url: (q) => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`,
        selector: ".mw-search-result-heading a, #firstHeading",
    },
];

const NAV_TIMEOUT_MS = 15_000;

/** First-result URL across the engine chain, or null if nothing usable. */
export async function firstHit(page: Page, query: string): Promise<string | null> {
    for (const engine of ENGINES) {
        const hit = await tryEngine(page, engine, query);
        if (hit) return hit;
    }
    return null;
}

async function tryEngine(page: Page, engine: Engine, query: string): Promise<string | null> {
    try {
        await page.goto(engine.url(query), { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

        // Wikipedia's "redirect on exact title match" lands on the article
        // page directly — the search-results selector misses, but the
        // current URL itself IS the result. Skip it: Wikipedia is in
        // BLOCKED_DOMAINS and isn't a useful proxy test target.
        if (engine.name === "wikipedia") {
            const cur = new URL(page.url());
            if (cur.hostname.endsWith("wikipedia.org") && cur.pathname.startsWith("/wiki/")) {
                return null;
            }
        }

        const candidates = await page.$$eval(engine.selector, (els) =>
            els.map((e) => (e as HTMLAnchorElement).href).filter((h) => !!h));

        for (const raw of candidates) {
            const resolved = engine.unwrap ? engine.unwrap(raw) : raw;
            if (
                resolved &&
                /^https?:/i.test(resolved) &&
                !isOnSearchEngine(resolved) &&
                !isBlockedDomain(resolved)
            ) {
                return resolved;
            }
        }
        return null;
    } catch {
        return null;
    }
}

/** Bing wraps result URLs as `https://www.bing.com/ck/a?...&u=a1<b64-target>&ntb=1`. */
function unwrapBing(href: string): string | null {
    try {
        const u = new URL(href);
        if (!u.hostname.endsWith("bing.com")) return href;
        const param = u.searchParams.get("u");
        if (!param) return null;
        // Format: "a1<base64-no-padding>" — strip the 2-char prefix.
        const b64 = param.startsWith("a1") ? param.slice(2) : param;
        const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
        const decoded = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
        if (/^https?:/i.test(decoded)) return decoded;
        return null;
    } catch {
        return null;
    }
}

function isOnSearchEngine(href: string): boolean {
    try {
        const h = new URL(href).hostname;
        return /(?:^|\.)(?:bing|duckduckgo|google|brave|yandex|ya)\.(?:com|ru)$/i.test(h);
    } catch {
        return false;
    }
}

const BLOCKED_DOMAINS = [
    "wikipedia.org",
    "wiktionary.org",
    "wikimedia.org",
    "merriam-webster.com",
    "dictionary.com",
    "britannica.com",
    "britannica.co.uk",
    "amazon.com",
    "amazon.co.uk",
    "youtube.com",
    "youtu.be",
    "reddit.com",
    "quora.com",
    "twitter.com",
    "x.com",
    "facebook.com",
    "instagram.com",
    "tiktok.com",
    "linkedin.com",
    "cambridge.org",
    "usnews.com",
    "dictionary.com",
];

function isBlockedDomain(href: string): boolean {
    try {
        const hostname = new URL(href).hostname.replace(/^www\./, "");
        return BLOCKED_DOMAINS.some((d) => hostname === d || hostname.endsWith("." + d));
    } catch {
        return false;
    }
}
