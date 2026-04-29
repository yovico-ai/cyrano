// Integration tests exercising the HTML mini-rewriter's dispatch into the CSS
// rewriter for inline <style> content and style="..." attributes.

import { describe, expect, it } from "vitest";
import { rewriteHtmlString } from "../../src/patches/html-rewriter";

const tag = (url: string): string =>
    url + (url.includes("?") ? "&" : "?") + "p=1";

describe("HTML rewriter dispatches to CSS rewriter", () => {
    it("rewrites url() inside an inline <style> tag", () => {
        const got = rewriteHtmlString(
            "<style>.icon { background: url('icon.png'); }</style>",
            tag,
        );
        expect(got).toContain("background: url('icon.png?p=1')");
    });

    it("rewrites @import inside an inline <style> tag", () => {
        const got = rewriteHtmlString(
            '<style>@import "/style.css";</style>',
            tag,
        );
        expect(got).toContain('@import "/style.css?p=1"');
    });

    it("rewrites url() inside a style=\"...\" attribute", () => {
        const got = rewriteHtmlString(
            '<div style="background: url(\'img.png\')">x</div>',
            tag,
        );
        expect(got).toContain("img.png?p=1");
    });

    it("rewrites style attribute on URL-bearing elements alongside their src/href", () => {
        const got = rewriteHtmlString(
            '<a href="/x" style="background: url(\'bg.png\')">link</a>',
            tag,
        );
        expect(got).toContain("/x?p=1");      // href rewritten
        expect(got).toContain("bg.png?p=1"); // style url() rewritten
    });

    it("preserves non-URL CSS in <style> content", () => {
        const got = rewriteHtmlString(
            "<style>.x { color: red; padding: 1px; }</style>",
            tag,
        );
        expect(got).toContain(".x { color: red; padding: 1px; }");
        expect(got).not.toContain("p=1");
    });
});
