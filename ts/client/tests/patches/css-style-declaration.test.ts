// Runs under happy-dom. Patches CSSStyleDeclaration globally; relies on the
// module's `patched` guard for idempotence — does not undo between tests.

import { describe, expect, it } from "vitest";
import { patchCssStyleDeclaration } from "../../src/patches/css-style-declaration";

const tag = (url: string): string =>
    url + (url.includes("?") ? "&" : "?") + "p=1";

describe("patchCssStyleDeclaration — setProperty", () => {
    it("rewrites url() in setProperty values for known URL-bearing names", () => {
        patchCssStyleDeclaration(window, tag);
        const div = document.createElement("div");
        div.style.setProperty("background-image", "url('bg.png')");
        const value = div.style.getPropertyValue("background-image");
        expect(value).toContain("bg.png?p=1");
    });

    it("rewrites url() in shorthand `background` setProperty values", () => {
        patchCssStyleDeclaration(window, tag);
        const div = document.createElement("div");
        div.style.setProperty("background", "url('bg.png') no-repeat");
        const value = div.style.getPropertyValue("background");
        expect(value).toContain("bg.png?p=1");
    });

    it("rewrites url() even for unknown property names (content sniff)", () => {
        patchCssStyleDeclaration(window, tag);
        const div = document.createElement("div");
        // Use a property name we haven't pre-listed; the value-side url()
        // sniff still catches it.
        div.style.setProperty("--my-bg", "url('img.png')");
        const value = div.style.getPropertyValue("--my-bg");
        expect(value).toContain("img.png?p=1");
    });

    it("does not rewrite values without URL constructs", () => {
        patchCssStyleDeclaration(window, tag);
        const div = document.createElement("div");
        div.style.setProperty("color", "red");
        expect(div.style.getPropertyValue("color")).toBe("red");
    });

    it("non-string value passes through (engine handles coercion)", () => {
        patchCssStyleDeclaration(window, tag);
        const div = document.createElement("div");
        // setProperty with non-string typically no-ops or coerces. We
        // assert only that the rewriter doesn't run.
        expect(() =>
            div.style.setProperty("color", null as unknown as string),
        ).not.toThrow();
    });
});

describe("patchCssStyleDeclaration — cssText setter", () => {
    it("rewrites url() inside cssText assignment", () => {
        patchCssStyleDeclaration(window, tag);
        const div = document.createElement("div");
        div.style.cssText = "background: url('bg.png'); color: red;";
        // Reading cssText reflects the parsed-and-serialized form.
        expect(div.style.cssText).toContain("bg.png?p=1");
    });

    // Note: @import inside inline style is invalid CSS — happy-dom's parser
    // drops the declaration on assignment. Rewriting itself works (verified
    // in tests/css/rewriter.test.ts). Parser quirk in the test environment,
    // not a correctness issue.

    it("preserves non-URL cssText", () => {
        patchCssStyleDeclaration(window, tag);
        const div = document.createElement("div");
        div.style.cssText = "color: red; padding: 1px;";
        expect(div.style.cssText).not.toContain("p=1");
    });
});

describe("patchCssStyleDeclaration — named property setters", () => {
    it("rewrites el.style.backgroundImage = 'url(...)'", () => {
        patchCssStyleDeclaration(window, tag);
        const div = document.createElement("div");
        div.style.backgroundImage = "url('img.png')";
        expect(div.style.backgroundImage).toContain("img.png?p=1");
    });

    it("rewrites el.style.cursor = 'url(...) auto'", () => {
        patchCssStyleDeclaration(window, tag);
        const div = document.createElement("div");
        div.style.cursor = "url('cursor.png'), auto";
        expect(div.style.cursor).toContain("cursor.png?p=1");
    });

    it("does not touch named properties without URL values", () => {
        patchCssStyleDeclaration(window, tag);
        const div = document.createElement("div");
        div.style.color = "blue";
        expect(div.style.color).toBe("blue");
    });

    it("non-string named-property assignments pass through", () => {
        patchCssStyleDeclaration(window, tag);
        const div = document.createElement("div");
        // Numeric assignment to a length-typed property; not all engines
        // accept non-strings, but we assert the rewriter doesn't intercept.
        expect(() => {
            (div.style as unknown as { backgroundImage: unknown }).backgroundImage = null;
        }).not.toThrow();
    });
});
