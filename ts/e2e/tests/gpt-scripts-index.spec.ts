// Test: GPT + APS slot size validity after proxy script injection.
//
// Guards against: "No GPT slots provided to apstag.fetchBids() had valid sizes"
//
// Two failure modes under test:
//
//   1. Script self-identification breaks — GPT uses
//      document.scripts[document.scripts.length - 1] to locate itself while
//      executing synchronously. If our rewriter.js injection changes what
//      element sits at that index, the wrong script element is read.
//
//   2. Numeric sizes become non-numbers — apstag validates slot sizes with
//      typeof size[0] === 'number'. Any proxy transformation that coerces
//      JSON numbers to strings causes the check to fail and the error to throw.

import { test, expect } from "@playwright/test";
import { gotoURL, fixtureURL } from "../helpers.ts";

test("GPT slot sizes remain valid numbers after proxy injection", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", err => errors.push(err.message));

    await page.goto(gotoURL(fixtureURL("fixture-a.test", "/gpt-scripts-index.html")));

    const result = page.locator("#result");
    await expect(result).toHaveAttribute("data-pass", "true", { timeout: 5_000 });

    // Report the detail attributes on failure for easier diagnosis.
    const selfId = await result.getAttribute("data-self-id");
    const validSlots = await result.getAttribute("data-valid-slots");
    if (errors.length > 0 || selfId !== "gpt-shim" || validSlots !== "1") {
        const text = await result.textContent();
        throw new Error(
            `GPT fixture failed — self=${selfId} validSlots=${validSlots} text="${text}"\n` +
            (errors.length ? "Page errors:\n" + errors.join("\n") : ""),
        );
    }
});
