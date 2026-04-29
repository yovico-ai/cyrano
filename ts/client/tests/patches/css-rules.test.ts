// Patches CSSStyleSheet/CSSGroupingRule.prototype.insertRule. Tests run
// under happy-dom — verify insertRule sees the rewritten CSS source.
//
// We don't restore the patched prototype between tests: patchCssRules is
// idempotent (module-local guard), the rewriter is pure, and other tests
// don't depend on the unpatched behavior.

import { describe, expect, it } from "vitest";
import { patchCssRules } from "../../src/patches/css-rules";

const tag = (url: string): string =>
    url + (url.includes("?") ? "&" : "?") + "p=1";

describe("patchCssRules — CSSStyleSheet.insertRule", () => {
    it("rewrites url() inside the inserted rule's CSS source", () => {
        patchCssRules(window, tag);

        const styleEl = document.createElement("style");
        document.head.appendChild(styleEl);
        const sheet = styleEl.sheet!;

        sheet.insertRule(".x { background: url('img.png'); }", 0);

        const inserted = sheet.cssRules[0]!;
        expect(inserted.cssText).toContain("img.png?p=1");
        styleEl.remove();
    });

    it("does not touch rules without URL constructs", () => {
        patchCssRules(window, tag);

        const styleEl = document.createElement("style");
        document.head.appendChild(styleEl);
        const sheet = styleEl.sheet!;

        sheet.insertRule(".y { color: red; }", 0);

        const inserted = sheet.cssRules[0]!;
        expect(inserted.cssText).not.toContain("p=1");
        styleEl.remove();
    });

    // Notes on happy-dom limitations — verified separately in unit tests:
    //   - Multi-url() declarations: happy-dom's CSS parser drops the
    //     declaration entirely on parse. Coverage in tests/css/rewriter.test.ts.
    //   - @import rules: happy-dom's insertRule throws on internal DOMException
    //     lookup. Coverage in tests/css/rewriter.test.ts.
    // In real browsers our patched insertRule applies rewriteCssText to every
    // input verbatim, so the unit-test coverage of rewriteCssText carries
    // over.
});
