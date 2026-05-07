// Runs under happy-dom. The wrapper now dispatches on whether obj is a
// Document — if so, rewrite as HTML; otherwise pass through verbatim.

import { describe, expect, it, vi } from "vitest";
import { wrapDocumentWrite } from "../../src/wrappers/document-write";

const tag = (url: string): string =>
    url + (url.includes("?") ? "&" : "?") + "proxified=1";

const DOCUMENT_NODE = 9;

function fakeDocument(opts: { hasRewriter?: boolean } = {}): {
    write: ReturnType<typeof vi.fn>;
    writeln: ReturnType<typeof vi.fn>;
    nodeType: number;
    defaultView: { $rewriter?: object } | null;
} {
    return {
        write: vi.fn(),
        writeln: vi.fn(),
        nodeType: DOCUMENT_NODE,
        defaultView: opts.hasRewriter ? { $rewriter: {} } : {},
    };
}

describe("wrapDocumentWrite — Document target", () => {
    it("rewrites HTML in document.write payloads", () => {
        const doc = fakeDocument();
        const wrapper = wrapDocumentWrite({ obj: doc }, tag);
        wrapper.write('<img src="/a.png">');

        const written = doc.write.mock.calls[0]?.[0] as string;
        expect(written).toContain('src="/a.png?proxified=1"');
    });

    it("rewrites HTML in document.writeln payloads", () => {
        const doc = fakeDocument();
        const wrapper = wrapDocumentWrite({ obj: doc }, tag);
        wrapper.writeln('<a href="/x">link</a>');

        const written = doc.writeln.mock.calls[0]?.[0] as string;
        expect(written).toContain('href="/x?proxified=1"');
    });

    it("joins variadic args before HTML parsing", () => {
        const doc = fakeDocument();
        const wrapper = wrapDocumentWrite({ obj: doc }, tag);
        wrapper.write('<img src="', '/foo.png', '">');

        const written = doc.write.mock.calls[0]?.[0] as string;
        expect(written).toContain('src="/foo.png?proxified=1"');
    });

    it("preserves non-URL HTML untouched", () => {
        const doc = fakeDocument();
        const wrapper = wrapDocumentWrite({ obj: doc }, tag);
        wrapper.write("<p>plain text</p>");

        const written = doc.write.mock.calls[0]?.[0] as string;
        expect(written).toContain("<p>plain text</p>");
    });
});

describe("wrapDocumentWrite — non-Document target (must NOT rewrite as HTML)", () => {
    it("forwards write() args verbatim when obj has no Document nodeType", () => {
        // Imagine a Node.js-style stream: `.write(buf)` where buf is binary.
        // If we treated it as HTML, the bytes would be mangled.
        const stream = { write: vi.fn(), writeln: vi.fn(), nodeType: undefined };
        const wrapper = wrapDocumentWrite({ obj: stream }, tag);
        const buffer = "<some-data-that-looks-like-tag>raw bytes</some-data-that-looks-like-tag>";

        wrapper.write(buffer);
        expect(stream.write).toHaveBeenCalledWith(buffer);
        // No HTML rewriting happened — no `proxified=1` injected.
        expect(stream.write.mock.calls[0]?.[0]).not.toContain("proxified=1");
    });

    it("preserves multiple-arg signatures for non-Document targets", () => {
        const stream = { write: vi.fn(), writeln: vi.fn(), nodeType: undefined };
        const wrapper = wrapDocumentWrite({ obj: stream }, tag);
        // Some libraries' write() takes (buf, offset, length) — must not be
        // collapsed into a single string.
        wrapper.write("data", 0, 4);
        expect(stream.write).toHaveBeenCalledWith("data", 0, 4);
    });

    it("forwards binary-style writes verbatim (Uint8Array)", () => {
        const stream = { write: vi.fn(), writeln: vi.fn(), nodeType: undefined };
        const wrapper = wrapDocumentWrite({ obj: stream }, tag);
        const bytes = new Uint8Array([1, 2, 3]);
        wrapper.write(bytes);
        expect(stream.write).toHaveBeenCalledWith(bytes);
    });

    it("does nothing when obj has no .write method (won't crash)", () => {
        const wrapper = wrapDocumentWrite({ obj: { nodeType: 1 } }, tag);
        expect(() => wrapper.write("anything")).not.toThrow();
    });

    it("does nothing when obj is null/undefined (won't crash)", () => {
        const wrapper = wrapDocumentWrite({ obj: null }, tag);
        expect(() => wrapper.write("anything")).not.toThrow();
    });
});

describe("wrapDocumentWrite — head bootstrap injection", () => {
    const BOOTSTRAP = "<!--BOOTSTRAP-->";
    const getBootstrapHtml = () => BOOTSTRAP;

    it("injects bootstrap after <head> when window has no $rewriter", () => {
        const doc = fakeDocument();
        const wrapper = wrapDocumentWrite({ obj: doc }, tag, getBootstrapHtml);
        wrapper.write("<html><head><title>Ad</title></head><body></body></html>");

        const written = doc.write.mock.calls[0]?.[0] as string;
        expect(written).toContain(`<head>${BOOTSTRAP}`);
    });

    it("injects bootstrap after <head> written via writeln", () => {
        const doc = fakeDocument();
        const wrapper = wrapDocumentWrite({ obj: doc }, tag, getBootstrapHtml);
        wrapper.writeln("<html><head></head><body>content</body></html>");

        const written = doc.writeln.mock.calls[0]?.[0] as string;
        expect(written).toContain(`<head>${BOOTSTRAP}`);
    });

    it("does not inject when window already has $rewriter", () => {
        const doc = fakeDocument({ hasRewriter: true });
        const wrapper = wrapDocumentWrite({ obj: doc }, tag, getBootstrapHtml);
        wrapper.write("<html><head></head><body></body></html>");

        const written = doc.write.mock.calls[0]?.[0] as string;
        expect(written).not.toContain(BOOTSTRAP);
    });

    it("does not inject when HTML has no <head> and no <script>", () => {
        const doc = fakeDocument();
        const wrapper = wrapDocumentWrite({ obj: doc }, tag, getBootstrapHtml);
        wrapper.write("<div><p>fragment</p></div>");

        const written = doc.write.mock.calls[0]?.[0] as string;
        expect(written).not.toContain(BOOTSTRAP);
    });

    it("does not inject when getBootstrapHtml is null", () => {
        const doc = fakeDocument();
        const wrapper = wrapDocumentWrite({ obj: doc }, tag, null);
        wrapper.write("<html><head></head><body></body></html>");

        const written = doc.write.mock.calls[0]?.[0] as string;
        expect(written).not.toContain(BOOTSTRAP);
    });
});

describe("wrapDocumentWrite — script-fragment bootstrap injection", () => {
    const BOOTSTRAP = "<!--BOOTSTRAP-->";
    const getBootstrapHtml = () => BOOTSTRAP;

    it("prepends bootstrap before <script> fragment when window has no $rewriter", () => {
        const doc = fakeDocument();
        const wrapper = wrapDocumentWrite({ obj: doc }, tag, getBootstrapHtml);
        wrapper.write("<script>var x = 1;<\/script>");

        const written = doc.write.mock.calls[0]?.[0] as string;
        const bsIdx = written.indexOf(BOOTSTRAP);
        const scIdx = written.indexOf("<script>");
        expect(bsIdx).toBeGreaterThanOrEqual(0);
        expect(bsIdx).toBeLessThan(scIdx);
    });

    it("prepends bootstrap via writeln too", () => {
        const doc = fakeDocument();
        const wrapper = wrapDocumentWrite({ obj: doc }, tag, getBootstrapHtml);
        wrapper.writeln("<script>var x = 1;<\/script>");

        const written = doc.writeln.mock.calls[0]?.[0] as string;
        expect(written).toContain(BOOTSTRAP);
        expect(written.indexOf(BOOTSTRAP)).toBeLessThan(written.indexOf("<script>"));
    });

    it("does not prepend when window already has $rewriter", () => {
        const doc = fakeDocument({ hasRewriter: true });
        const wrapper = wrapDocumentWrite({ obj: doc }, tag, getBootstrapHtml);
        wrapper.write("<script>var x = 1;<\/script>");

        const written = doc.write.mock.calls[0]?.[0] as string;
        expect(written).not.toContain(BOOTSTRAP);
    });

    it("does not prepend for plain HTML fragment with no <script>", () => {
        const doc = fakeDocument();
        const wrapper = wrapDocumentWrite({ obj: doc }, tag, getBootstrapHtml);
        wrapper.write("<div>ad content</div>");

        const written = doc.write.mock.calls[0]?.[0] as string;
        expect(written).not.toContain(BOOTSTRAP);
    });
});
