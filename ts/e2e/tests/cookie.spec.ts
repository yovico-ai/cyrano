// Tests for document.cookie patching and cross-site cookie isolation.
//
// These require:
//  1. The proxy running: /tmp/cyrano --assets ./go/assets
//  2. /etc/hosts: 127.0.0.1  fixture-a.test  fixture-b.test
//  3. npm test (from ts/e2e/) starts the fixture server automatically.
//
// The proxy injects rewriter.js which patches document.cookie. Page JS then
// reads/writes through the patched API; we assert the result element's data-pass.

import { test, expect, Page } from "@playwright/test";
import { gotoURL, fixtureURL } from "../helpers.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

async function loadFixture(page: Page, hostname: string, path: string): Promise<void> {
    await page.goto(gotoURL(fixtureURL(hostname, path)));
}

async function assertPass(page: Page): Promise<void> {
    const result = page.locator("#result");
    await expect(result).toHaveAttribute("data-pass", "true", { timeout: 5_000 });
}

// ── document.cookie getter & setter ──────────────────────────────────────────

test("document.cookie getter strips prefix, shows only own site's cookies", async ({ page, context }) => {
    // Pre-seed the proxy-side cookie store with two prefixed cookies via
    // Set-Cookie response headers from the fixture server.
    //
    // fixture-a.test prefix: __crn__fixture-a_test__
    // other site prefix:     __crn__fixture-b_test__
    //
    // We set them by navigating through the proxy to a seed endpoint that
    // returns Set-Cookie headers. The proxy stores them prefixed.
    // Simpler: set them directly on the context since the proxy stores cookies
    // under its own origin (localhost:9081).
    await context.addCookies([
        {
            name:   "__crn__fixture-a_test__mine",
            value:  "goldmine",
            domain: "localhost",
            path:   "/",
        },
        {
            name:   "__crn__fixture-b_test__theirs",
            value:  "secret",
            domain: "localhost",
            path:   "/",
        },
    ]);

    await loadFixture(page, "fixture-a.test", "/cookie-document-cookie.html");

    // The page JS reads document.cookie and checks it sees only "mine=goldmine".
    // It also writes a cookie and checks the raw store via /echo-cookies.
    // The full assertion is inside the page; we just check data-pass.
    await assertPass(page);
});

test("document.cookie setter adds the site prefix before storage", async ({ page, context }) => {
    // Start with no pre-seeded cookies. The fixture page writes one cookie and
    // then fetches /echo-cookies to verify the raw store has the prefixed name.
    await loadFixture(page, "fixture-a.test", "/cookie-document-cookie.html");
    await assertPass(page);
});

// ── cross-site isolation ──────────────────────────────────────────────────────

test("cross-site: site A cannot read site B's cookies", async ({ page, context }) => {
    // Pre-seed both sites' cookies in the proxy's cookie store.
    await context.addCookies([
        {
            name:   "__crn__fixture-a_test__a_cookie",
            value:  "for_a",
            domain: "localhost",
            path:   "/",
        },
        {
            name:   "__crn__fixture-b_test__b_cookie",
            value:  "for_b",
            domain: "localhost",
            path:   "/",
        },
    ]);

    // Load the cross-site fixture via fixture-a.test. It checks that only
    // a_cookie is visible and b_cookie is not.
    await loadFixture(page, "fixture-a.test", "/cookie-cross-site.html");
    await assertPass(page);
});

// ── challenge-page document.cookie shim ──────────────────────────────────────

test("challenge page: document.cookie getter strips prefix, setter adds prefix", async ({ page, context }) => {
    // The fixture HTML contains /cdn-cgi/challenge-platform/ so the proxy
    // injects the minimal challengePathFixScript shim instead of the full
    // rewriter bootstrap. The shim patches document.cookie.
    //
    // Pre-seed a cookie that the shim would have stored after a JS set: the
    // raw browser store holds the prefixed name; the getter must strip it.
    await context.addCookies([
        {
            name:   "__crn__fixture-a_test__chl_seed",
            value:  "seeded",
            domain: "localhost",
            path:   "/",
        },
    ]);

    await loadFixture(page, "fixture-a.test", "/challenge-cookie.html");
    await assertPass(page);
});
