// @vitest-environment node
//
// CSS rewriter parity tests. Mirrors go/src/internal/cssrewrite/rewriter_test.go
// to catch divergence between client and server. The same input must produce
// the same rewriting decision (which URLs are touched, which are not).

import { describe, expect, it } from "vitest";
import { rewriteCssText } from "../../src/css/rewriter";

const tag = (url: string): string =>
    url + (url.includes("?") ? "&" : "?") + "p=1";

describe("rewriteCssText — url() forms", () => {
    it("rewrites double-quoted url()", () => {
        expect(rewriteCssText('background: url("img.png")', tag))
            .toBe('background: url("img.png?p=1")');
    });

    it("rewrites single-quoted url()", () => {
        expect(rewriteCssText("background: url('img.png')", tag))
            .toBe("background: url('img.png?p=1')");
    });

    it("rewrites unquoted url() — defensively wraps result in double quotes", () => {
        expect(rewriteCssText("background: url(img.png)", tag))
            .toBe('background: url("img.png?p=1")');
    });

    it("preserves whitespace around url() contents", () => {
        // The regex allows whitespace around the URL; we don't preserve it
        // verbatim but we DO preserve the canonical form (quoted, no extra ws).
        expect(rewriteCssText("background: url(  img.png  )", tag))
            .toBe('background: url("img.png?p=1")');
    });

    it("rewrites multiple url() in a single declaration", () => {
        const got = rewriteCssText(
            ".a { background: url('a.png'), url('b.png'); }",
            tag,
        );
        expect(got).toBe(".a { background: url('a.png?p=1'), url('b.png?p=1'); }");
    });

    it("rewrites url() with absolute URLs", () => {
        const got = rewriteCssText(
            'background: url("http://example.com/i.png")',
            tag,
        );
        expect(got).toBe('background: url("http://example.com/i.png?p=1")');
    });
});

describe("rewriteCssText — @import forms", () => {
    it("rewrites @import \"...\"", () => {
        expect(rewriteCssText('@import "/style.css";', tag))
            .toBe('@import "/style.css?p=1";');
    });

    it("rewrites @import '...'", () => {
        expect(rewriteCssText("@import '/style.css';", tag))
            .toBe("@import '/style.css?p=1';");
    });

    it("rewrites @import url(...) form via the url() pass", () => {
        expect(rewriteCssText('@import url("/style.css");', tag))
            .toBe('@import url("/style.css?p=1");');
    });

    it("rewrites @import url(...) with media query suffix", () => {
        const got = rewriteCssText(
            '@import url("landscape.css") screen and (orientation: landscape);',
            tag,
        );
        expect(got).toContain('@import url("landscape.css?p=1")');
        expect(got).toContain("screen and (orientation: landscape)");
    });
});

describe("rewriteCssText — passthrough cases", () => {
    it("empty input returns unchanged", () => {
        expect(rewriteCssText("", tag)).toBe("");
    });

    it("CSS without any URL constructs survives", () => {
        const css = ".a { color: red; font-size: 14px; }";
        expect(rewriteCssText(css, tag)).toBe(css);
    });

    it("does not touch quoted strings that aren't url() or @import", () => {
        // `content` accepts an arbitrary string; not a URL.
        const css = '.a::before { content: "x.png"; }';
        expect(rewriteCssText(css, tag)).toBe(css);
    });

    it("data URLs go through the rewriter (the URL layer passes them through)", () => {
        // We pass them through rewriteOne — the real `rewriteUrl` would
        // recognise the data: scheme and return it unchanged. With our test
        // tagger they get appended; that's the contract: rewriteCssText
        // doesn't filter, it delegates.
        const got = rewriteCssText(
            'background: url("data:image/png;base64,abc")',
            tag,
        );
        expect(got).toContain("data:image/png;base64,abc?p=1");
    });
});

describe("rewriteCssText — preservation", () => {
    it("preserves declarations surrounding the URL", () => {
        const css = ".a { color: red; background: url('x.png'); padding: 1px; }";
        expect(rewriteCssText(css, tag)).toBe(
            ".a { color: red; background: url('x.png?p=1'); padding: 1px; }",
        );
    });

    it("preserves selectors and at-rules", () => {
        const css = `
            @media (max-width: 600px) {
                .icon { background: url('icon.png'); }
            }`;
        const got = rewriteCssText(css, tag);
        expect(got).toContain("@media (max-width: 600px)");
        expect(got).toContain("background: url('icon.png?p=1')");
    });
});
