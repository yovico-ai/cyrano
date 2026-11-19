// Runs under happy-dom. Exercises the HTML mini-rewriter end-to-end:
// parse string → walk → rewrite URL attrs → serialize back.

import { unmarked } from "../../src/js/marks";
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
        expect(unmarked(String(got))).toContain("$rewriter.wrap_get_location(location)");
    });

    it("rewrites `obj.location` inside inline script content", () => {
        const got = rewriteHtmlString(
            "<script>var x = window.location;</script>",
            tag,
        );
        expect(unmarked(String(got))).toContain("$rewriter.wrap_location");
    });

    it("does not touch <script src=...> external scripts (already-attribute-rewritten path)", () => {
        const got = rewriteHtmlString(
            '<script src="/lib.js"></script>',
            tag,
        );
        // src attribute went through URL rewriting…
        expect(got).toContain('src="/lib.js?proxified=1"');
        // …but no JS rewriting happened (there's no inline body).
        expect(unmarked(String(got))).not.toContain("$rewriter.wrap_");
    });

    it("preserves plain inline scripts without hooked identifiers", () => {
        const got = rewriteHtmlString(
            "<script>var x = 1 + 2;</script>",
            tag,
        );
        expect(got).toContain("var x = 1 + 2");
        expect(unmarked(String(got))).not.toContain("$rewriter.wrap_");
    });
});

describe("rewriteHtmlString — a preload link's imagesrcset", () => {
    it("rewrites each candidate URL", () => {
        const got = rewriteHtmlString('<link rel="preload" as="image" imagesrcset="https://cdn.example/a.webp 16w, https://cdn.example/b.webp 32w">', (u) => `P(${u})`);
        expect(got).toContain('imagesrcset="P(https://cdn.example/a.webp) 16w, P(https://cdn.example/b.webp) 32w"');
    });
});

describe("rewriteHtmlString — a <meta> CSP", () => {
    it("'none' stays 'none'; other source lists get the proxy origin", () => {
        const got = rewriteHtmlString(`<meta http-equiv="Content-Security-Policy" content="object-src 'none'; img-src https://a.example">`, (u) => u, "http://proxy.example");
        expect(got).toContain(`object-src 'none';`);
        expect(got).toContain(`img-src https://a.example http://proxy.example`);
    });
});

describe("rewriteHtmlString — the document's own tags stay", () => {
    const id = (u: string) => u;
    it("keeps doctype, html, head and body as written (a frame written whole)", () => {
        const html = '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body class="b"><script>document.body.appendChild(x)</script></body></html>';
        expect(unmarked(rewriteHtmlString(html, id))).toBe(html);
    });
    it("keeps a write that is only the opening tags", () => {
        expect(rewriteHtmlString("<html><body>", id)).toBe("<html><body>");
    });
    it("leaves a <body> inside script text and comments alone", () => {
        const html = '<body><script>var s="<body>";</script><!-- <head> --></body>';
        expect(unmarked(rewriteHtmlString(html, id))).toBe(html);
    });
    it("still rewrites what is between them", () => {
        const out = rewriteHtmlString('<html><body><img src="https://a.example/x.png"></body></html>', (u) => "/p/" + u);
        expect(out).toMatch(/^<html><body><img src="\/p\/https:\/\/a\.example\/x\.png"[^>]*><\/body><\/html>$/);
    });
});

// Style attributes are parsed under another name (a parse of `style`
// anywhere is checked against the page's CSP and reported), then named
// style again: what comes out is as before.
describe("rewriteHtmlString — style attributes, edited where they stand", () => {
    it("rewrites url() in a style attribute and names it style", () => {
        const got = rewriteHtmlString('<div style="background:url(/a.png)">x</div>', tag);
        expect(got).toBe('<div style="background:url(&quot;/a.png?proxified=1&quot;)" crn-o="{&quot;style&quot;:&quot;background:url(/a.png)&quot;}">x</div>');
    });
    it("leaves other attributes, quoted text and raw text alone", () => {
        const html = `<p title="style=x" data-style='y' STYLE=color:red class=a>style="z"</p><script>var s = '<b style=q>';</script>`;
        // Nothing in it to rewrite: the page's markup, character for character.
        expect(rewriteHtmlString(html, tag)).toBe(html);
    });
    it("keeps a valueless style attribute", () => {
        expect(rewriteHtmlString("<b style>x</b>", tag)).toBe("<b style>x</b>");
    });
});

// Found by the tokenization spec (spec/HtmlTok.agda) and
// tests/native/written-markup-vs-chromium: markup is edited where it
// stands, tokenized as the browser will.
describe("rewriteHtmlString — the page's markup, edited where it stands", () => {
    it("foreign content is markup: an SVG <style>'s and <title>'s elements are rewritten", () => {
        expect(rewriteHtmlString('<svg><style><image href="/i.png"/></style></svg>', tag)).toContain('href="/i.png?proxified=1"');
        expect(rewriteHtmlString('<svg><title><a href="/t">t</a></title></svg>', tag)).toContain('href="/t?proxified=1"');
        // </foreignObject> while an HTML element is open is ignored: the
        // <style> after it is HTML's, raw text.
        const mis = '<svg><foreignObject><b>x</foreignObject><style><img src="/f.png"></style></svg>';
        expect(rewriteHtmlString(mis, tag)).toBe(mis);
        // …while an HTML <style> is raw text.
        expect(rewriteHtmlString('<style>a{}</style><b>x', tag)).toBe('<style>a{}</style><b>x');
    });
    it("a held tag's URL is rewritten: <body background>, <frame src>", () => {
        expect(rewriteHtmlString('<body background="/b.png"><p>x', tag)).toContain('background="/b.png?proxified=1"');
        expect(rewriteHtmlString('<frameset><frame src="/f"></frameset>', tag)).toContain('<frame src="/f?proxified=1"');
    });
    it("leaves an element a chunk opens open", () => {
        expect(rewriteHtmlString('<div id="a">', tag)).toBe('<div id="a">');
        expect(rewriteHtmlString("<p><table><tr><td>c", tag)).toBe("<p><table><tr><td>c");
    });
    it("a noscript's content is the page's text (scripting on), markup with it off", () => {
        expect(rewriteHtmlString('<noscript><img src="/n.png"></noscript>', tag)).toBe('<noscript><img src="/n.png"></noscript>');
        expect(rewriteHtmlString('<noscript><img src="/n.png"></noscript>', tag, "", undefined, { scripting: false })).toContain('src="/n.png?proxified=1"');
    });
    it("parses in its context: no tag in a <textarea>, SVG in an <svg>", () => {
        expect(rewriteHtmlString('<img src="/x">', tag, "", undefined, { within: { ns: "html", name: "textarea" } })).toBe('<img src="/x">');
        expect(rewriteHtmlString('<image href="/s.png"/>', tag, "", undefined, { within: { ns: "svg", name: "svg" } })).toContain('href="/s.png?proxified=1"');
        // In HTML, <image> is an <img>: its href is not a URL.
        expect(rewriteHtmlString('<image href="/s.png">', tag)).toBe('<image href="/s.png">');
    });
    it("reads a value as the parser does, and writes it back escaped", () => {
        expect(rewriteHtmlString('<img src="/a?x=1&amp;y=2">', tag)).toContain('src="/a?x=1&amp;y=2&amp;proxified=1"');
        expect(rewriteHtmlString("<a href=/u title='keep'>", tag)).toMatch(/^<a href="\/u\?proxified=1" title='keep' crn-o=/);
    });
    it("leaves a script whose end is not in the chunk as written", () => {
        expect(rewriteHtmlString("<script>location.href", tag)).toBe("<script>location.href");
    });
});

// A refresh navigates like a link: written markup's <meta> went straight
// to the origin (spec/Refresh.agda).
describe("rewriteHtmlString — <meta http-equiv=refresh>", () => {
    it("proxifies the refresh's URL, the rest as written", () => {
        expect(rewriteHtmlString('<meta http-equiv="Refresh" content="0; url=\'/next\'">', tag))
            .toMatch(/^<meta http-equiv="Refresh" content="0; url='\/next\?proxified=1'" crn-o=/);
        expect(rewriteHtmlString('<meta http-equiv=refresh content="5">', tag)).toBe('<meta http-equiv=refresh content="5">');
        expect(rewriteHtmlString('<meta name=refresh content="0;url=/x">', tag)).toBe('<meta name=refresh content="0;url=/x">');
    });
});
