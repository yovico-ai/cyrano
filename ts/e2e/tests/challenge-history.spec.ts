// Tests for the minimal challenge shim's history.pushState/replaceState
// patch (challengePathFixScript in inject.go).
//
// These require:
//  1. The proxy running: /tmp/cyrano --assets ./go/assets
//  2. /etc/hosts: 127.0.0.1  fixture-a.test  fixture-b.test
//  3. npm test (from ts/e2e/) starts the fixture server automatically.
//
// Not Go-unit-testable: the shim is hand-authored JS embedded in a Go string
// literal and only runs meaningfully inside a real browser's DOM/History API.

import { test, expect, Page } from "@playwright/test";
import { gotoURL, fixtureURL } from "../helpers.ts";

async function loadFixture(page: Page, hostname: string, path: string): Promise<void> {
    await page.goto(gotoURL(fixtureURL(hostname, path)));
}

async function assertPass(page: Page): Promise<void> {
    const result = page.locator("#result");
    await expect(result).toHaveAttribute("data-pass", "true", { timeout: 5_000 });
}

test("challenge page: history.pushState/replaceState keep the proxy prefix and don't double it", async ({ page }) => {
    await loadFixture(page, "fixture-a.test", "/challenge-history.html");
    await assertPass(page);
});
