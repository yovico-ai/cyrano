// End-to-end coverage for document.write(...) → HTML rewriter → JS rewriter
// dispatch. The HTML mini-rewriter walks each <script> element in the parsed
// payload and runs its body through the JS rewriter, so a `document.write`
// payload containing an inline script with `location` accesses comes out the
// other side with `$rewriter.wrap_*` calls already injected — same as if the
// HTML had been rewritten server-side.

import { describe, expect, it, vi } from "vitest";
import { wrapDocumentWrite } from "../../src/wrappers/document-write";

const tag = (url: string): string =>
    url + (url.includes("?") ? "&" : "?") + "proxified=1";

const DOCUMENT_NODE = 9;

function fakeDocument(): {
    write: ReturnType<typeof vi.fn>;
    writeln: ReturnType<typeof vi.fn>;
    nodeType: number;
} {
    return {
        write: vi.fn(),
        writeln: vi.fn(),
        nodeType: DOCUMENT_NODE,
    };
}

describe("document.write end-to-end — inline script rewriting", () => {
    it("rewrites bare `location` inside a <script> in the document.write payload", () => {
        const doc = fakeDocument();
        const wrapper = wrapDocumentWrite({ obj: doc }, tag);
        wrapper.write("<script>var u = location;</script>");

        const written = doc.write.mock.calls[0]?.[0] as string;
        // URL attributes were already rewritten on the script tag itself if any;
        // and inline body got the JS rewriter pass.
        expect(written).toContain("$rewriter.wrap_get_location(location)");
    });

    it("rewrites both URL attributes AND inline script content in one payload", () => {
        const doc = fakeDocument();
        const wrapper = wrapDocumentWrite({ obj: doc }, tag);
        wrapper.write(
            '<img src="/img.png">' +
            "<script>document.write('inner');</script>" +
            '<a href="/x">link</a>',
        );

        const written = doc.write.mock.calls[0]?.[0] as string;
        // Static attribute rewriting:
        expect(written).toContain('src="/img.png?proxified=1"');
        expect(written).toContain('href="/x?proxified=1"');
        // Inline script rewriting:
        expect(written).toContain("$rewriter.wrap_document_write");
    });

    it("rewrites inline <style> CSS content in the document.write payload", () => {
        const doc = fakeDocument();
        const wrapper = wrapDocumentWrite({ obj: doc }, tag);
        wrapper.write("<style>.x { background: url('bg.png'); }</style>");

        const written = doc.write.mock.calls[0]?.[0] as string;
        expect(written).toContain("bg.png?proxified=1");
    });

    it("rewrites style=\"...\" attributes in the document.write payload", () => {
        const doc = fakeDocument();
        const wrapper = wrapDocumentWrite({ obj: doc }, tag);
        wrapper.write('<div style="background: url(\'bg.png\')">x</div>');

        const written = doc.write.mock.calls[0]?.[0] as string;
        expect(written).toContain("bg.png?proxified=1");
    });

    it("a fully-mixed payload — attrs, inline JS, inline CSS, style attr — all rewrite", () => {
        const doc = fakeDocument();
        const wrapper = wrapDocumentWrite({ obj: doc }, tag);
        wrapper.write(`
            <link rel="stylesheet" href="/style.css">
            <style>.a { background: url('a.png'); }</style>
            <div style="background-image: url('d.png')">
                <script>var loc = location.href;</script>
            </div>
        `);

        const written = doc.write.mock.calls[0]?.[0] as string;
        expect(written).toContain("/style.css?proxified=1");
        expect(written).toContain("a.png?proxified=1");
        expect(written).toContain("d.png?proxified=1");
        expect(written).toContain("$rewriter.wrap_get_location(location)");
    });
});
