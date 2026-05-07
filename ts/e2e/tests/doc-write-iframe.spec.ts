// Test: $rewriter accessible in ad iframes written via document.write.
//
// Guards against:
//   TypeError: Cannot read properties of undefined (reading 'wrap_member_expression')
//
// Root cause: GPT (pubads_impl.js) calls document.write() to inject ad scripts
// into iframes that have no bootstrap. Our wrap_document_write rewrites the
// scripts (adding $rewriter.wrap_* calls), but window.$rewriter is undefined
// in unbootstrapped iframes, so the rewritten code throws.
//
// Fix: the eval preamble walks up the frame tree to borrow $rewriter from the
// nearest bootstrapped ancestor (all proxied frames share the same proxy origin,
// so parent access is always same-origin safe).

import { test, expect } from "@playwright/test";
import { gotoURL, fixtureURL } from "../helpers.ts";

test("$rewriter accessible in iframe written via document.write", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", err => errors.push(err.message));

    await page.goto(gotoURL(fixtureURL("fixture-a.test", "/doc-write-iframe.html")));

    const result = page.locator("#result");
    await expect(result).toHaveAttribute("data-pass", "true", { timeout: 5_000 });

    if (errors.length > 0) {
        const text = await result.textContent();
        throw new Error(
            `doc-write-iframe fixture failed — text="${text}"\n` +
            "Page errors:\n" + errors.join("\n"),
        );
    }
});
