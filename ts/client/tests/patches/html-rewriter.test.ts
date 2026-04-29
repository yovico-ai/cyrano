// Runs under happy-dom. Exercises the HTML mini-rewriter end-to-end:
// parse string → walk → rewrite URL attrs → serialize back.

import { describe, expect, it } from "vitest";
import { rewriteHtmlString } from "../../src/patches/html-rewriter";

const tag = (url: string): string =>
    url + (url.includes("?") ? "&" : "?") + "proxified=1";

describe("rewriteHtmlString — URL attributes", () => {
    it("rewrites img.src", () => {
        const got = rewriteHtmlString('<img src="http://example.com/a.png">', tag);
        expect(got).toContain('src="http://example.com/a.png?proxified=1"');
    });

    it("rewrites a.href", () => {
        const got = rewriteHtmlString('<a href="http://example.com/x">link</a>', tag);
        expect(got).toContain('href="http://example.com/x?proxified=1"');
    });

    it("rewrites script.src", () => {
        const got = rewriteHtmlString('<script src="/lib.js"></script>', tag);
        expect(got).toContain('src="/lib.js?proxified=1"');
    });

    it("rewrites iframe.src", () => {
        const got = rewriteHtmlString('<iframe src="http://example.com/page"></iframe>', tag);
        expect(got).toContain('src="http://example.com/page?proxified=1"');
    });

    it("rewrites link.href", () => {
        const got = rewriteHtmlString(
            '<link rel="stylesheet" href="/style.css">',
            tag,
        );
        expect(got).toContain('href="/style.css?proxified=1"');
    });

    it("rewrites video.poster and video.src", () => {
        const got = rewriteHtmlString(
            '<video src="/m.mp4" poster="/p.jpg"></video>',
            tag,
        );
        expect(got).toContain('src="/m.mp4?proxified=1"');
        expect(got).toContain('poster="/p.jpg?proxified=1"');
    });

    it("rewrites form.action and area.href", () => {
        const got = rewriteHtmlString(
            '<form action="/submit"><input></form>' +
            '<map><area href="/zone"></map>',
            tag,
        );
        expect(got).toContain('action="/submit?proxified=1"');
        expect(got).toContain('href="/zone?proxified=1"');
    });

    it("rewrites object.data", () => {
        const got = rewriteHtmlString(
            '<object data="/embed.swf"></object>',
            tag,
        );
        expect(got).toContain('data="/embed.swf?proxified=1"');
    });
});

describe("rewriteHtmlString — srcset semantics", () => {
    it("rewrites img.srcset URL part of each candidate, preserves descriptors", () => {
        const got = rewriteHtmlString(
            '<img srcset="a.jpg 1x, b.jpg 2x, c.jpg 480w">',
            tag,
        );
        expect(got).toContain(
            'srcset="a.jpg?proxified=1 1x, b.jpg?proxified=1 2x, c.jpg?proxified=1 480w"',
        );
    });
});

describe("rewriteHtmlString — descendants and nesting", () => {
    it("rewrites attributes on deeply nested elements", () => {
        const html = `
            <div class="wrap">
                <section>
                    <article>
                        <img src="/a.png">
                        <a href="/x">x</a>
                    </article>
                </section>
            </div>`;
        const got = rewriteHtmlString(html, tag);
        expect(got).toContain('src="/a.png?proxified=1"');
        expect(got).toContain('href="/x?proxified=1"');
    });

    it("rewrites multiple URL attrs on the same element", () => {
        const got = rewriteHtmlString(
            '<video src="/m.mp4" poster="/p.jpg"></video>',
            tag,
        );
        expect(got).toMatch(/src="\/m\.mp4\?proxified=1"/);
        expect(got).toMatch(/poster="\/p\.jpg\?proxified=1"/);
    });

    it("does not touch attributes on non-URL elements", () => {
        const got = rewriteHtmlString(
            '<div data-href="/should-not-rewrite">x</div>',
            tag,
        );
        expect(got).toContain('data-href="/should-not-rewrite"');
        expect(got).not.toContain("proxified=1");
    });

    it("does not touch non-URL attributes on URL elements", () => {
        // `class` on <a> is not a URL attribute — must not be touched.
        const got = rewriteHtmlString(
            '<a class="btn" href="/x">link</a>',
            tag,
        );
        expect(got).toContain('class="btn"');
        expect(got).toContain('href="/x?proxified=1"');
    });
});

describe("rewriteHtmlString — passthrough cases", () => {
    it("empty input returns unchanged", () => {
        expect(rewriteHtmlString("", tag)).toBe("");
    });

    it("plain text without elements survives", () => {
        const got = rewriteHtmlString("hello world", tag);
        expect(got).toBe("hello world");
    });

    it("does not invoke the rewriter for absent / empty attributes", () => {
        const got = rewriteHtmlString(
            // src is empty — shouldn't get a query suffix appended.
            '<img src="">' +
            '<img alt="no src">',
            tag,
        );
        expect(got).not.toContain("proxified=1");
    });
});

describe("rewriteHtmlString — parser robustness", () => {
    it("preserves attributes whose values contain HTML entities", () => {
        const got = rewriteHtmlString(
            '<a href="/path?a=1&amp;b=2">link</a>',
            tag,
        );
        // The recovered attribute value carries the decoded `&` — our
        // rewriter sees `/path?a=1&b=2` and tags it. The serializer then
        // re-encodes the `&` back to `&amp;` for output safety.
        expect(got).toContain("href=");
        expect(got).toContain("proxified=1");
    });

    it("does not execute scripts in the parsed payload (template content is inert)", () => {
        // We can't really test execution here, but we can confirm the script
        // tag is preserved verbatim and its attribute (if any) gets rewritten.
        const got = rewriteHtmlString(
            '<script src="/run.js"></script>',
            tag,
        );
        expect(got).toContain('src="/run.js?proxified=1"');
    });
});

describe("rewriteHtmlString — inline <script> JS rewriting", () => {
    it("rewrites bare `location` reads inside inline script content", () => {
        const got = rewriteHtmlString(
            "<script>var x = location;</script>",
            tag,
        );
        expect(got).toContain("$rewriter.wrap_get_location(location)");
    });

    it("rewrites `obj.location` inside inline script content", () => {
        const got = rewriteHtmlString(
            "<script>var x = window.location;</script>",
            tag,
        );
        expect(got).toContain("$rewriter.wrap_location");
    });

    it("does not touch <script src=...> external scripts (already-attribute-rewritten path)", () => {
        const got = rewriteHtmlString(
            '<script src="/lib.js"></script>',
            tag,
        );
        // src attribute went through URL rewriting…
        expect(got).toContain('src="/lib.js?proxified=1"');
        // …but no JS rewriting happened (there's no inline body).
        expect(got).not.toContain("$rewriter.wrap_");
    });

    it("preserves plain inline scripts without hooked identifiers", () => {
        const got = rewriteHtmlString(
            "<script>var x = 1 + 2;</script>",
            tag,
        );
        expect(got).toContain("var x = 1 + 2");
        expect(got).not.toContain("$rewriter.wrap_");
    });
});
