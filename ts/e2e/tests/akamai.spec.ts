// Test: Akamai Bot Manager-shaped scripts pass through the JS rewriter unmodified.
//
// The fixture loads a script at /rAnD0m/sEgMnt?v=<UUID> — a URL that
// isChallengeScript() detects and skips rewriting. The script contains
// computed-property call patterns that would produce a TypeError if
// wrap_member_expression were applied.
//
// PASS: window.__akamaiFixtureRan === true and no uncaught error.
// FAIL: TypeError in onerror, or the flag is never set.

import { test, expect, Page } from "@playwright/test";
import { gotoURL, fixtureURL } from "../helpers.ts";

test("Akamai-shaped script executes without TypeError", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", err => errors.push(err.message));

    await page.goto(gotoURL(fixtureURL("fixture-a.test", "/akamai-passthrough.html")));

    const result = page.locator("#result");
    await expect(result).toHaveAttribute("data-pass", "true", { timeout: 5_000 });

    // Belt-and-suspenders: no uncaught JS errors.
    if (errors.length > 0) {
        throw new Error("Uncaught page errors:\n" + errors.join("\n"));
    }
});
